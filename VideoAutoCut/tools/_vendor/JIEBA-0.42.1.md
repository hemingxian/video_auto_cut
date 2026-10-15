# jieba 0.42.1 vendoring record

- Upstream: https://github.com/fxsjy/jieba/tree/v0.42.1
- Release archive: https://files.pythonhosted.org/packages/c6/cb/18eeb235f833b726522d7ebed54f2278ce28ba9438e3135ab0278d9792a2/jieba-0.42.1.tar.gz
- Archive SHA-256: `055ca12f62674fafed09427f176506079bc135638a14e23e25be909131928db2`
- License: MIT; the upstream `LICENSE` is retained in `_vendor/jieba/LICENSE`.
- Purpose: deterministic offline Chinese word boundaries for subtitle wrapping in the pip-less embedded Python runtime.
- Packaging: `pack-runtime.ts` already copies `VideoAutoCut/tools`; no runtime download or `pip install` is used.

Besides the required license, only files loaded by
`jieba.Tokenizer.cut(..., HMM=True)` are retained. The seven code/data files are
copied byte-for-byte from the 0.42.1 distribution; upstream logic and data are
unchanged. The MIT `LICENSE` text is unchanged and has one normalized terminal
LF; its exact delivered bytes are frozen below and by `.gitattributes`.

| Relative path | Bytes | SHA-256 |
|---|---:|---|
| `jieba/LICENSE` | 1076 | `907635cd4f8ff6bdf64fa2b7d79c0e1859070f247ad0573bb8c834ecdfb66479` |
| `jieba/__init__.py` | 19809 | `b47cefcfd0bf683b0c708c1de0328df83be2c35264637c442106e79d739fb7f3` |
| `jieba/_compat.py` | 2785 | `ce079f41be19a25857607275336073703a3fa116c66472821a1f6f53472a6023` |
| `jieba/dict.txt` | 5071852 | `7197c3211ddd98962b036cdf40324d1ea2bfaa12bd028e68faa70111a88e12a8` |
| `jieba/finalseg/__init__.py` | 2659 | `2168475bf522c0dae9d0a5e2bcb63c11b8c15931a622035cb8905d1e77e94f84` |
| `jieba/finalseg/prob_emit.py` | 1321732 | `27d46b1c9efe4dd148fde8be042a21be40e3562d0c7f1273f9de7abae12ebb8d` |
| `jieba/finalseg/prob_start.py` | 93 | `14c5706ced5cd3b42eb4873d4b88f7f52a7bdf80fbd767bc4423d361e20c5330` |
| `jieba/finalseg/prob_trans.py` | 241 | `54dfbc252ed71480d4f0cdfdf516ecfbe44efd0f6c3c64b158e7039f2906c91b` |

Retained upstream payload: 8 files, 6,420,247 bytes. The first tokenization
builds the prefix dictionary in memory and may write
`videoautocut-jieba-0.42.1-7197c3211ddd.cache` only beneath
`<VIDEOAUTO_DATA_ROOT or VIDEOAUTO_WORKSPACE_DIR>/.videoautocut/cache/jieba/`.
The name binds the cache to this vendored version and dictionary. If no
workspace is explicit, the target is unavailable, or the target falls inside
the runtime/install tree, VideoAutoCut builds the dictionary in memory and
writes no cache. `VIDEOAUTO_TEMP_DIR` and the operating-system temp directory
are never cache destinations.
