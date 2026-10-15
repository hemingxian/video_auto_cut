use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Component, Path, PathBuf};

use crate::models::{Shot, ShotPlan};
use crate::persistence::write_json_pretty_atomic;

const MANIFEST_FILE: &str = "clip_manifest.json";

#[derive(Debug, Serialize, Deserialize)]
pub(crate) struct ClipManifest {
    schema_version: u32,
    run_id: String,
    task_revision: u64,
    shots: Vec<ShotClips>,
}

#[derive(Debug, Serialize, Deserialize)]
struct ShotClips {
    shot_id: String,
    // Paths are relative to clips_root, so moving a complete task keeps it usable.
    paths: Vec<PathBuf>,
}

fn run_id(clips_root: &Path) -> Result<String> {
    Ok(clips_root
        .parent()
        .and_then(Path::file_name)
        .and_then(|name| name.to_str())
        .context("剪辑目录缺少任务标识")?
        .to_owned())
}

pub(crate) fn checked_clip_path(clips_root: &Path, path: &Path) -> Result<PathBuf> {
    let root = fs::canonicalize(clips_root)?;
    let actual = fs::canonicalize(path)
        .with_context(|| format!("剪辑文件不存在或无法访问: {}", path.display()))?;
    if !actual.starts_with(&root)
        || !actual
            .extension()
            .is_some_and(|ext| ext.eq_ignore_ascii_case("mp4"))
    {
        bail!("剪辑路径不属于当前任务的 MP4 产物: {}", path.display());
    }
    let metadata = fs::metadata(&actual)?;
    if !metadata.is_file() || metadata.len() == 0 {
        bail!("剪辑文件为空或不是普通文件: {}", path.display());
    }
    Ok(actual)
}

fn validate_plan(plan: &ShotPlan) -> Result<()> {
    let mut ids = HashSet::new();
    let mut numbers = HashSet::new();
    if plan.shots.is_empty() {
        bail!("当前任务没有可合成的分镜");
    }
    for shot in &plan.shots {
        if shot.shot_id.trim().is_empty() || !ids.insert(&shot.shot_id) {
            bail!("分镜 ID 缺失或重复: {}", shot.shot_id);
        }
        if shot.shot == 0 || !numbers.insert(shot.shot) {
            bail!("分镜编号无效或重复: {}", shot.shot);
        }
    }
    Ok(())
}

impl ClipManifest {
    pub(crate) fn start(clips_root: &Path, plan: &ShotPlan) -> Result<Self> {
        validate_plan(plan)?;
        let manifest = Self {
            schema_version: 1,
            run_id: run_id(clips_root)?,
            task_revision: plan.task_revision,
            shots: Vec::new(),
        };
        // Invalidate previous results before a retry, including if its first shot fails.
        manifest.save(clips_root)?;
        Ok(manifest)
    }

    fn save(&self, clips_root: &Path) -> Result<()> {
        write_json_pretty_atomic(&clips_root.join(MANIFEST_FILE), self)
    }

    pub(crate) fn record(
        &mut self,
        clips_root: &Path,
        shot: &Shot,
        paths: Vec<PathBuf>,
    ) -> Result<()> {
        if paths.is_empty() {
            bail!("分镜 #{} ({}) 未返回剪辑文件", shot.shot, shot.title);
        }
        let root = fs::canonicalize(clips_root)?;
        let mut seen = HashSet::new();
        let mut relative_paths = Vec::new();
        for path in paths {
            let actual = checked_clip_path(clips_root, &path)?;
            if !seen.insert(actual.clone()) {
                bail!("分镜 {} 返回重复剪辑路径: {}", shot.shot_id, path.display());
            }
            relative_paths.push(actual.strip_prefix(&root)?.to_owned());
        }
        self.shots.retain(|entry| entry.shot_id != shot.shot_id);
        self.shots.push(ShotClips {
            shot_id: shot.shot_id.clone(),
            paths: relative_paths,
        });
        self.save(clips_root)
    }

    fn resolve(&self, clips_root: &Path, plan: &ShotPlan) -> Result<Vec<PathBuf>> {
        if self.schema_version != 1
            || self.run_id != run_id(clips_root)?
            || self.task_revision != plan.task_revision
        {
            bail!("剪辑清单格式、任务或脚本版本不匹配，请重新剪辑当前任务");
        }
        let mut by_id = HashMap::new();
        for entry in &self.shots {
            if !plan.shots.iter().any(|shot| shot.shot_id == entry.shot_id)
                || by_id.insert(&entry.shot_id, entry).is_some()
            {
                bail!("剪辑清单包含重复或不属于当前脚本的分镜: {}", entry.shot_id);
            }
        }
        plan.shots
            .iter()
            .map(|shot| {
                let entry = by_id.get(&shot.shot_id).with_context(|| {
                    format!("分镜 #{} ({}) 尚未完成剪辑", shot.shot, shot.title)
                })?;
                if entry.paths.is_empty() {
                    bail!("分镜 #{} ({}) 的剪辑清单为空", shot.shot, shot.title);
                }
                let mut actual_paths = Vec::new();
                let mut seen = HashSet::new();
                for path in &entry.paths {
                    if path.is_absolute()
                        || path
                            .components()
                            .any(|part| !matches!(part, Component::Normal(_)))
                    {
                        bail!("剪辑清单包含非法相对路径: {}", path.display());
                    }
                    let actual = checked_clip_path(clips_root, &clips_root.join(path))
                        .with_context(|| {
                            format!("分镜 #{} ({}) 的剪辑不可用", shot.shot, shot.title)
                        })?;
                    if !seen.insert(actual.clone()) {
                        bail!("分镜 {} 的剪辑清单包含重复文件", shot.shot_id);
                    }
                    actual_paths.push(actual);
                }
                // The producer returns matches in rank order; do not re-sort filenames.
                Ok(actual_paths.remove(0))
            })
            .collect()
    }
}

fn legacy_shot_number(name: &str) -> Option<usize> {
    let number = if let Some(rest) = name.strip_prefix("shot_") {
        let digits = rest.bytes().take_while(u8::is_ascii_digit).count();
        if digits < 3 || !(rest.len() == digits || rest[digits..].starts_with('_')) {
            return None;
        }
        &rest[..digits]
    } else {
        let (digits, title) = name.split_once(" · ")?;
        if digits.len() < 2 || title.trim().is_empty() {
            return None;
        }
        digits
    };
    if !number.bytes().all(|value| value.is_ascii_digit()) {
        return None;
    }
    number.parse::<usize>().ok().filter(|value| *value > 0)
}

fn import_legacy(clips_root: &Path, plan: &ShotPlan) -> Result<ClipManifest> {
    let mut directories = HashMap::new();
    for entry in fs::read_dir(clips_root)? {
        let entry = entry?;
        if !entry.file_type()?.is_dir() {
            continue;
        }
        let Some(number) = legacy_shot_number(&entry.file_name().to_string_lossy()) else {
            continue;
        };
        if !plan.shots.iter().any(|shot| shot.shot == number) {
            continue;
        }
        if directories.insert(number, entry.path()).is_some() {
            bail!("历史任务的分镜 #{number} 存在多个剪辑目录，无法安全确定应使用的文件");
        }
    }
    let root = fs::canonicalize(clips_root)?;
    let mut shots = Vec::new();
    for shot in &plan.shots {
        let directory = directories.get(&shot.shot).with_context(|| {
            format!("分镜 #{} ({}) 没有找到历史剪辑目录", shot.shot, shot.title)
        })?;
        let mut paths = Vec::new();
        for entry in fs::read_dir(directory)? {
            let entry = entry?;
            if entry.file_type()?.is_file()
                && entry
                    .path()
                    .extension()
                    .is_some_and(|ext| ext.eq_ignore_ascii_case("mp4"))
            {
                paths.push(
                    checked_clip_path(clips_root, &entry.path())?
                        .strip_prefix(&root)?
                        .to_owned(),
                );
            }
        }
        paths.sort(); // Preserve the historical first-file selection for legacy tasks only.
        if paths.is_empty() {
            bail!("分镜 #{} ({}) 没有可用的历史剪辑", shot.shot, shot.title);
        }
        shots.push(ShotClips {
            shot_id: shot.shot_id.clone(),
            paths,
        });
    }
    Ok(ClipManifest {
        schema_version: 1,
        run_id: run_id(clips_root)?,
        task_revision: plan.task_revision,
        shots,
    })
}

pub(crate) fn resolve_clips(clips_root: &Path, plan: &ShotPlan) -> Result<Vec<PathBuf>> {
    validate_plan(plan)?;
    let file = clips_root.join(MANIFEST_FILE);
    let manifest = match fs::read_to_string(&file) {
        Ok(text) => serde_json::from_str::<ClipManifest>(&text)
            .with_context(|| format!("剪辑清单损坏，不能退回目录猜测: {}", file.display()))?,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            if fs::read_dir(clips_root)?.any(|entry| {
                entry.is_ok_and(|entry| {
                    entry
                        .file_name()
                        .to_string_lossy()
                        .starts_with(&format!(".{MANIFEST_FILE}.vacut."))
                })
            }) {
                bail!("剪辑清单写入曾中断，请重新剪辑；不能把该任务当作没有清单的历史任务");
            }
            let manifest = import_legacy(clips_root, plan)?;
            manifest.resolve(clips_root, plan)?;
            manifest.save(clips_root)?;
            manifest
        }
        Err(error) => return Err(error).context("无法读取剪辑清单"),
    };
    manifest.resolve(clips_root, plan)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            // 进程号 + 时间戳在同一进程的并行测试线程之间会撞名（macOS 时钟只到微秒），
            // 两个测试共用一个目录就会互删文件、偶发失败。加一个进程内原子计数器保证唯一。
            static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
            let nonce = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let root = std::env::temp_dir().join(format!(
                "vacut_clip_manifest_{}_{}_{nonce}",
                std::process::id(),
                NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
            ));
            fs::create_dir_all(root.join("run_test/clips")).unwrap();
            Self(root)
        }
        fn clips(&self) -> PathBuf {
            self.0.join("run_test/clips")
        }
        fn video(&self, relative: &str) -> PathBuf {
            let path = self.clips().join(relative);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(&path, b"video").unwrap();
            path
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    fn plan() -> ShotPlan {
        serde_json::from_value(json!({"topic":"测试", "task_revision":3, "shots":[
            {"shot_id":"id-a", "shot":1, "title":"开场"},
            {"shot_id":"id-b", "shot":2, "title":"结尾"}
        ]}))
        .unwrap()
    }

    #[test]
    fn actual_paths_survive_reload_title_order_changes_and_directory_layout() {
        let f = Fixture::new();
        let mut p = plan();
        let first = f.video("arbitrary 中文/z_first.mp4");
        let second_rank = f.video("arbitrary 中文/a_second.MP4");
        let second = f.video("another/path/b.mp4");
        let mut manifest = ClipManifest::start(&f.clips(), &p).unwrap();
        manifest
            .record(&f.clips(), &p.shots[0], vec![first.clone(), second_rank])
            .unwrap();
        manifest
            .record(&f.clips(), &p.shots[1], vec![second.clone()])
            .unwrap();
        f.video("01 · 开场/000_stale.mp4");
        p.shots.swap(0, 1);
        p.shots[0].shot = 1;
        p.shots[1].shot = 2;
        p.shots[1].title = "改名后仍属于同一分镜".into();
        assert_eq!(
            resolve_clips(&f.clips(), &p).unwrap(),
            vec![
                fs::canonicalize(second).unwrap(),
                fs::canonicalize(first).unwrap()
            ]
        );
        let moved = f.0.join("moved");
        fs::create_dir_all(&moved).unwrap();
        fs::rename(f.0.join("run_test"), moved.join("run_test")).unwrap();
        assert_eq!(
            resolve_clips(&moved.join("run_test/clips"), &p)
                .unwrap()
                .len(),
            2
        );
    }

    #[test]
    fn imports_both_historical_formats_and_preserves_first_sorted_file() {
        let f = Fixture::new();
        let p = plan();
        let first = f.video("shot_001_intro/001.MP4");
        f.video("shot_001_intro/002.mp4");
        fs::create_dir_all(f.clips().join("shot_001_intro/000.mp4")).unwrap();
        let second = f.video("02 · 中文 空格 · 后缀/only.mp4");
        let paths = resolve_clips(&f.clips(), &p).unwrap();
        assert_eq!(
            paths,
            vec![
                fs::canonicalize(first).unwrap(),
                fs::canonicalize(second).unwrap()
            ]
        );
        assert!(f.clips().join(MANIFEST_FILE).is_file());
        assert_eq!(resolve_clips(&f.clips(), &p).unwrap(), paths);
    }

    #[test]
    fn legacy_numbers_do_not_truncate_large_shot_numbers() {
        for (name, expected) in [
            ("shot_001_intro", Some(1)),
            ("shot_120", Some(120)),
            ("shot_1000_title", Some(1000)),
            ("100 · 标题", Some(100)),
            ("shot_12_short", None),
            ("shot_001x", None),
            ("scene_001", None),
            ("00 · 标题", None),
            ("01 · ", None),
            ("abc · 标题", None),
        ] {
            assert_eq!(legacy_shot_number(name), expected, "{name}");
        }
    }

    #[test]
    fn ambiguous_legacy_directories_fail_without_creating_manifest() {
        let f = Fixture::new();
        f.video("shot_001_intro/a.mp4");
        f.video("01 · 开场/b.mp4");
        f.video("02 · 结尾/c.mp4");
        assert!(
            resolve_clips(&f.clips(), &plan())
                .unwrap_err()
                .to_string()
                .contains("多个")
        );
        assert!(!f.clips().join(MANIFEST_FILE).exists());
    }

    #[test]
    fn incomplete_retry_and_bad_manifests_never_fall_back_to_old_files() {
        let f = Fixture::new();
        let p = plan();
        f.video("01 · 开场/a.mp4");
        f.video("02 · 结尾/b.mp4");
        resolve_clips(&f.clips(), &p).unwrap();
        ClipManifest::start(&f.clips(), &p).unwrap();
        assert!(resolve_clips(&f.clips(), &p).is_err());
        fs::write(f.clips().join(MANIFEST_FILE), b"broken").unwrap();
        assert!(
            resolve_clips(&f.clips(), &p)
                .unwrap_err()
                .to_string()
                .contains("损坏")
        );
    }

    #[test]
    fn interrupted_manifest_write_is_not_treated_as_a_legacy_task() {
        let f = Fixture::new();
        f.video("01 · 开场/a.mp4");
        f.video("02 · 结尾/b.mp4");
        fs::write(
            f.clips().join(format!(".{MANIFEST_FILE}.vacut.bak")),
            b"old manifest",
        )
        .unwrap();
        assert!(
            resolve_clips(&f.clips(), &plan())
                .unwrap_err()
                .to_string()
                .contains("中断")
        );
    }

    #[test]
    fn rejects_version_run_revision_and_identity_mismatches() {
        let f = Fixture::new();
        let p = plan();
        let first = f.video("a/a.mp4");
        let second = f.video("b/b.mp4");
        let mut manifest = ClipManifest::start(&f.clips(), &p).unwrap();
        manifest
            .record(&f.clips(), &p.shots[0], vec![first])
            .unwrap();
        manifest
            .record(&f.clips(), &p.shots[1], vec![second])
            .unwrap();
        let original = serde_json::to_value(&manifest).unwrap();
        for (field, value) in [
            ("schema_version", json!(2)),
            ("run_id", json!("other")),
            ("task_revision", json!(4)),
        ] {
            let mut changed = original.clone();
            changed[field] = value;
            write_json_pretty_atomic(&f.clips().join(MANIFEST_FILE), &changed).unwrap();
            assert!(resolve_clips(&f.clips(), &p).is_err());
        }
        manifest.shots[1].shot_id = manifest.shots[0].shot_id.clone();
        manifest.save(&f.clips()).unwrap();
        assert!(resolve_clips(&f.clips(), &p).is_err());
        let mut bad_plan = plan();
        bad_plan.shots[1].shot = 1;
        assert!(ClipManifest::start(&f.clips(), &bad_plan).is_err());
    }

    #[test]
    fn rejects_missing_empty_escape_and_duplicate_files() {
        let f = Fixture::new();
        let p = plan();
        let first = f.video("a/a.mp4");
        let second = f.video("b/b.mp4");
        let mut manifest = ClipManifest::start(&f.clips(), &p).unwrap();
        assert!(
            manifest
                .record(&f.clips(), &p.shots[0], vec![first.clone(), first.clone()])
                .is_err()
        );
        assert!(
            manifest
                .record(&f.clips(), &p.shots[0], vec![f.0.join("missing.mp4")])
                .is_err()
        );
        let outside = f.0.join("outside.mp4");
        fs::write(&outside, b"video").unwrap();
        assert!(
            manifest
                .record(&f.clips(), &p.shots[0], vec![outside])
                .is_err()
        );
        manifest
            .record(&f.clips(), &p.shots[0], vec![first.clone()])
            .unwrap();
        manifest
            .record(&f.clips(), &p.shots[1], vec![second.clone()])
            .unwrap();
        fs::write(&second, b"").unwrap();
        assert!(resolve_clips(&f.clips(), &p).is_err());
        fs::write(&second, b"video").unwrap();
        manifest.shots[0].paths = vec![PathBuf::from("../outside.mp4")];
        manifest.save(&f.clips()).unwrap();
        assert!(resolve_clips(&f.clips(), &p).is_err());
    }
}
