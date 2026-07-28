from __future__ import annotations

import argparse
import json
import math
import time
from datetime import UTC, datetime
from pathlib import Path
from typing import Iterable

import numpy as np
import torch
from torch import nn
from torch.nn import functional as F

from backend.production_recommender import DiskBackedUserKNN
from backend.training.evaluation import _build_cases


class BiasedMatrixFactorization(nn.Module):
    def __init__(self, users: int, items: int, rank: int) -> None:
        super().__init__()
        self.user_factors = nn.Embedding(users, rank)
        self.item_factors = nn.Embedding(items, rank)
        self.user_bias = nn.Embedding(users, 1)
        self.item_bias = nn.Embedding(items, 1)
        nn.init.normal_(self.user_factors.weight, std=0.02)
        nn.init.normal_(self.item_factors.weight, std=0.02)
        nn.init.zeros_(self.user_bias.weight)
        nn.init.zeros_(self.item_bias.weight)

    def forward(
        self,
        users: torch.Tensor,
        items: torch.Tensor,
        global_mean: float,
    ) -> torch.Tensor:
        interaction = (
            self.user_factors(users) * self.item_factors(items)
        ).sum(dim=1)
        return (
            global_mean
            + self.user_bias(users).squeeze(1)
            + self.item_bias(items).squeeze(1)
            + interaction
        )


def train(
    artifact_directory: Path,
    output: Path,
    epochs: int,
    rank: int,
    learning_rate: float,
    weight_decay: float,
    batch_size: int,
    users_per_block: int,
    seed: int,
    excluded_evaluation_users: int,
) -> dict:
    if output.exists():
        raise FileExistsError(f"输出文件已存在，拒绝覆盖: {output}")
    if not torch.cuda.is_available():
        raise RuntimeError("biased MF 全量训练需要 CUDA，本机当前不可用。")

    torch.manual_seed(seed)
    np.random.seed(seed)
    torch.set_float32_matmul_precision("high")
    device = torch.device("cuda")

    index = DiskBackedUserKNN(
        artifact_directory, similarity_mode="mean_centered"
    )
    cases = _build_cases(
        index,
        requested_users=excluded_evaluation_users,
        seed=seed,
        minimum_profile_ratings=50,
        holdout_fraction=0.2,
        maximum_holdout=20,
    )
    excluded_users = np.zeros(len(index.user_ids), dtype=np.bool_)
    excluded_indices = np.asarray(
        [case.user_idx for case in cases], dtype=np.int64
    )
    excluded_users[excluded_indices] = True

    excluded_rating_sum = 0.0
    excluded_rating_count = 0
    for user_idx in excluded_indices:
        start = int(index.csr_indptr[user_idx])
        stop = int(index.csr_indptr[user_idx + 1])
        excluded_rating_sum += float(
            np.asarray(index.csr_ratings[start:stop], dtype=np.float64).sum()
        )
        excluded_rating_count += stop - start
    all_rating_sum = float(
        np.asarray(index.csr_ratings, dtype=np.float64).sum()
    )
    training_rating_count = len(index.csr_ratings) - excluded_rating_count
    global_mean = (
        all_rating_sum - excluded_rating_sum
    ) / training_rating_count

    model = BiasedMatrixFactorization(
        users=len(index.user_ids),
        items=len(index.mal_ids),
        rank=rank,
    ).to(device)
    optimizer = torch.optim.AdamW(
        model.parameters(),
        lr=learning_rate,
        weight_decay=weight_decay,
    )

    block_count = math.ceil(len(index.user_ids) / users_per_block)
    epoch_reports = []
    training_started = time.perf_counter()
    for epoch in range(epochs):
        epoch_started = time.perf_counter()
        squared_error_sum = 0.0
        observed = 0
        blocks = np.arange(block_count)
        random = np.random.default_rng(seed + epoch)
        random.shuffle(blocks)
        for block_position, block in enumerate(blocks, start=1):
            first_user = int(block * users_per_block)
            last_user = min(
                first_user + users_per_block, len(index.user_ids)
            )
            first_rating = int(index.csr_indptr[first_user])
            last_rating = int(index.csr_indptr[last_user])
            counts = np.diff(
                index.csr_indptr[first_user : last_user + 1]
            )
            user_values = np.repeat(
                np.arange(first_user, last_user, dtype=np.int64),
                counts,
            )
            item_values = np.asarray(
                index.csr_indices[first_rating:last_rating],
                dtype=np.int64,
            )
            rating_values = np.asarray(
                index.csr_ratings[first_rating:last_rating],
                dtype=np.float32,
            )
            keep = ~excluded_users[user_values]
            user_values = user_values[keep]
            item_values = item_values[keep]
            rating_values = rating_values[keep]
            order = random.permutation(len(user_values))

            for batch_start in range(0, len(order), batch_size):
                selection = order[batch_start : batch_start + batch_size]
                users_tensor = torch.from_numpy(
                    user_values[selection]
                ).to(device, non_blocking=True)
                items_tensor = torch.from_numpy(
                    item_values[selection]
                ).to(device, non_blocking=True)
                ratings_tensor = torch.from_numpy(
                    rating_values[selection]
                ).to(device, non_blocking=True)

                optimizer.zero_grad(set_to_none=True)
                prediction = model(
                    users_tensor, items_tensor, global_mean
                )
                loss = F.mse_loss(prediction, ratings_tensor)
                loss.backward()
                optimizer.step()
                current_count = len(selection)
                squared_error_sum += float(loss.detach()) * current_count
                observed += current_count

            if block_position % 20 == 0 or block_position == block_count:
                print(
                    f"epoch={epoch + 1}/{epochs} "
                    f"block={block_position}/{block_count} "
                    f"rmse={math.sqrt(squared_error_sum / observed):.6f}",
                    flush=True,
                )

        epoch_reports.append(
            {
                "epoch": epoch + 1,
                "training_rmse": math.sqrt(squared_error_sum / observed),
                "seconds": time.perf_counter() - epoch_started,
                "ratings": observed,
            }
        )

    checkpoint = {
        "state_dict": {
            name: value.detach().cpu()
            for name, value in model.state_dict().items()
        },
        "metadata": {
            "created_at": datetime.now(UTC).isoformat(),
            "artifact": str(artifact_directory.resolve()),
            "users": len(index.user_ids),
            "items": len(index.mal_ids),
            "rank": rank,
            "global_mean": global_mean,
            "epochs": epochs,
            "learning_rate": learning_rate,
            "weight_decay": weight_decay,
            "batch_size": batch_size,
            "users_per_block": users_per_block,
            "seed": seed,
            "excluded_evaluation_users": excluded_indices.tolist(),
            "excluded_evaluation_user_count": len(excluded_indices),
            "training_ratings": training_rating_count,
            "epoch_reports": epoch_reports,
            "total_seconds": time.perf_counter() - training_started,
            "torch_version": torch.__version__,
            "cuda_version": torch.version.cuda,
            "gpu": torch.cuda.get_device_name(0),
        },
    }
    output.parent.mkdir(parents=True, exist_ok=True)
    torch.save(checkpoint, output)
    report_path = output.with_suffix(".json")
    report_path.write_text(
        json.dumps(checkpoint["metadata"], ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    return checkpoint["metadata"]


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(
        description="Train biased matrix factorization on the full corpus."
    )
    result.add_argument("artifact_directory", type=Path)
    result.add_argument("--output", required=True, type=Path)
    result.add_argument("--epochs", type=int, default=3)
    result.add_argument("--rank", type=int, default=32)
    result.add_argument("--learning-rate", type=float, default=0.01)
    result.add_argument("--weight-decay", type=float, default=1e-5)
    result.add_argument("--batch-size", type=int, default=262_144)
    result.add_argument("--users-per-block", type=int, default=8_192)
    result.add_argument("--seed", type=int, default=20260727)
    result.add_argument("--excluded-evaluation-users", type=int, default=500)
    return result


def main(arguments: Iterable[str] | None = None) -> None:
    args = parser().parse_args(arguments)
    result = train(
        artifact_directory=args.artifact_directory,
        output=args.output,
        epochs=args.epochs,
        rank=args.rank,
        learning_rate=args.learning_rate,
        weight_decay=args.weight_decay,
        batch_size=args.batch_size,
        users_per_block=args.users_per_block,
        seed=args.seed,
        excluded_evaluation_users=args.excluded_evaluation_users,
    )
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
