"""Export the frozen full-precision ranker for row-wise browser inference.

No fitting, quantization, or user records are included in the release.
Run from the repository root; source directories are explicit inputs.
"""
import argparse
import hashlib
import json
import sys
from pathlib import Path

import lightgbm as lgb
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from backend.production_recommender import DiskBackedUserKNN
from prepare_browser_model import browser_catalog

VERSION = 'ease-risk-lambdamart-2026-09-25'
PREFIX = 'ranker-20260925'


def write_json(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')


def package(args):
    out = args.output.resolve()
    out.mkdir(parents=True, exist_ok=False)
    source = args.source.resolve()
    items = np.load(source / 'item-indices.npy')
    n = len(items)
    catalog = browser_catalog(args.artifact)
    priors = dict(np.load(source / 'priors.npz'))
    matrix_names = ['ease', 'liked_to_low', 'disliked_to_low', 'disliked_to_high']
    source_hashes = {}
    for name in matrix_names:
        path = source / ('ease-weights.npy' if name == 'ease' else name + '.npy')
        values = np.load(path, mmap_mode='r')
        assert values.dtype == np.dtype('<f4') and values.shape == (n, n)
        values.tofile(out / (name + '.bin'))
        with path.open('rb') as stream:
            source_hashes[path.name] = hashlib.file_digest(stream, 'sha256').hexdigest()
    booster = lgb.Booster(model_file=str(args.ranker / 'avoid_low.txt'))
    trees = booster.dump_model()['tree_info']
    def validate(node):
        if 'leaf_value' in node:
            return
        assert node['decision_type'] == '<=' and node['missing_type'] == 'None'
        validate(node['left_child'])
        validate(node['right_child'])
    for tree in trees:
        validate(tree['tree_structure'])
    assert len(trees) == 200 and booster.num_feature() == 15
    metadata = {
        'schema': 1, 'algorithm': 'ease-risk-lambdamart', 'version': VERSION,
        'item_count': n, 'candidate_pool': 500, 'alpha': .3, 'risk_penalty': .3,
        'mal_ids': [catalog[int(i)]['mal_id'] for i in items],
        'series': [DiskBackedUserKNN._series_key(catalog[int(i)]['title_en']) for i in items],
        'counts': priors['counts'].tolist(), 'low': priors['low'].tolist(), 'high': priors['high'].tolist(),
        'risk_model': json.loads((source / 'risk-model.json').read_text()),
        'trees': [t['tree_structure'] for t in trees],
    }
    write_json(out / 'ranker.json', metadata)
    write_json(out / 'catalog.json', catalog)
    write_json(out / 'provenance.json', {
        'version': VERSION, 'matrix_source_sha256': source_hashes,
        'ranker_sha256': hashlib.sha256((args.ranker / 'avoid_low.txt').read_bytes()).hexdigest(),
        'risk_model_sha256': hashlib.sha256((source / 'risk-model.json').read_bytes()).hexdigest(),
        'relation_training_users': 80000, 'ranker_training_users': 16000,
        'personal_tuning': False, 'precision': 'Original float32 matrices and full JSON tree thresholds',
        'score_semantics': 'Relative ranking score, not a calibrated liking probability',
    })
    records = []
    for path in sorted(out.iterdir()):
        with path.open('rb') as stream:
            digest = hashlib.file_digest(stream, 'sha256').hexdigest()
        records.append({'path': PREFIX + '/' + path.name, 'bytes': path.stat().st_size,
                        'sha256': digest, 'url': args.base_url.rstrip('/') + '/' + path.name})
    catalog_record = next(r for r in records if r['path'].endswith('/catalog.json'))
    manifest = {'schema_version': 1, 'algorithm': 'ease-risk-lambdamart', 'model_version': VERSION,
                'data_version': 'user-animelist-v1+catalog-2026-27',
                'total_bytes': sum(r['bytes'] for r in records), 'catalog_items': len(catalog),
                'training_users': 96000, 'training_ratings': 0,
                'files': [r for r in records if r is not catalog_record], 'browser_catalog': catalog_record,
                'ranker_metadata': PREFIX + '/ranker.json', 'matrix_prefix': PREFIX + '/',
                'matrix_item_count': n}
    # Count only observations used by the relation model, not the full legacy dataset.
    indptr = np.load(args.artifact / 'csr_indptr.npy', mmap_mode='r')
    users = np.load(source / 'relation-user-indices.npy')
    manifest['training_ratings'] = int(np.sum(indptr[users + 1] - indptr[users]))
    write_json(out / 'browser-model-manifest.json', manifest)
    print(json.dumps({'output': str(out), 'bytes': manifest['total_bytes'], 'items': n}))


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    for name in ('artifact', 'source', 'ranker', 'output'):
        parser.add_argument('--' + name, type=Path, required=True)
    parser.add_argument('--base-url', required=True)
    package(parser.parse_args())
