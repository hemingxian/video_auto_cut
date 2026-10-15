use crate::persistence::write_json_pretty_atomic;
use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    fs,
    io::{BufReader, Read},
    path::{Path, PathBuf},
};
use walkdir::WalkDir;

#[derive(Default, Serialize, Deserialize)]
pub(crate) struct Checkpoint {
    version: u32,
    signature: String,
    plan_hash: String,
    #[serde(default)]
    output_dimensions: Option<[u32; 2]>,
    pub(crate) final_path: Option<PathBuf>,
    steps: Vec<CompletedStep>,
}
#[derive(Serialize, Deserialize)]
struct CompletedStep {
    name: String,
    files: BTreeMap<PathBuf, String>,
}

pub(crate) fn hash_file(path: &Path) -> Result<String> {
    let mut input = BufReader::new(fs::File::open(path)?);
    let mut hash = Sha256::new();
    let mut buffer = [0u8; 65536];
    loop {
        let count = input.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        hash.update(&buffer[..count]);
    }
    Ok(format!("{:x}", hash.finalize()))
}
impl Checkpoint {
    pub(crate) fn open_incremental(
        path: &Path,
        signature: &str,
        plan: &Path,
        resume: bool,
    ) -> Result<Self> {
        if !resume {
            return Self::open(path, signature, plan, false);
        }
        let mut value: Self = serde_json::from_slice(&fs::read(path)?)?;
        if value.version != 1 {
            bail!("检查点版本不支持");
        }
        // Per-shot receipts now validate inputs and output hashes; this legacy journal retains
        // the selected final path and output dimensions for compatible history recovery.
        value.signature = signature.into();
        value.steps.clear();
        Ok(value)
    }
    pub(crate) fn bind_output_dimensions(
        &mut self,
        width: u32,
        height: u32,
        resume: bool,
    ) -> Result<()> {
        if let Some(saved) = self.output_dimensions {
            if saved != [width, height] {
                bail!("成片尺寸与检查点不一致，请重新生成全部");
            }
        } else if resume
            && !matches!(
                (width, height),
                (1920, 1080) | (1080, 1920) | (1440, 1080) | (1080, 1440)
            )
        {
            bail!("旧检查点没有该分辨率的产物记录，请重新生成全部");
        }
        self.output_dimensions = Some([width, height]);
        Ok(())
    }

    pub(crate) fn open(path: &Path, signature: &str, plan: &Path, resume: bool) -> Result<Self> {
        if !resume {
            return Ok(Self {
                version: 1,
                signature: signature.into(),
                ..Self::default()
            });
        }
        let value: Self = serde_json::from_slice(
            &fs::read(path).context("此任务没有可用检查点，请选择重新生成全部")?,
        )?;
        if value.version != 1 || value.signature != signature || value.plan_hash != hash_file(plan)?
        {
            bail!("分镜或生成设置已变化，无法安全使用原断点，请选择重新生成全部");
        }
        Ok(value)
    }
    pub(crate) fn valid_prefix(&mut self, names: &[String], roots: &[PathBuf]) -> Result<usize> {
        let valid = self
            .steps
            .iter()
            .enumerate()
            .take_while(|(i, step)| {
                names.get(*i) == Some(&step.name)
                    && step.files.iter().all(|(file, hash)| {
                        roots.iter().any(|root| file.starts_with(root))
                            && hash_file(file).ok().as_ref() == Some(hash)
                    })
            })
            .count();
        // Invalidate downstream generated artifacts so their own caches cannot reuse stale results.
        for step in &self.steps[valid..] {
            for file in step.files.keys() {
                if !roots.iter().any(|root| file.starts_with(root)) {
                    bail!("检查点产物超出当前任务目录");
                }
                if file.is_file() {
                    let backup = file.with_file_name(format!(
                        "{}.invalid-{}",
                        file.file_name().unwrap().to_string_lossy(),
                        chrono::Utc::now().timestamp_nanos_opt().unwrap_or_default()
                    ));
                    fs::rename(file, backup)?;
                }
            }
        }
        self.steps.truncate(valid);
        Ok(valid)
    }
    pub(crate) fn record_partial_plan(&mut self, plan: &Path, checkpoint: &Path) -> Result<()> {
        self.plan_hash = hash_file(plan)?;
        write_json_pretty_atomic(checkpoint, self)
    }
    pub(crate) fn complete(
        &mut self,
        name: String,
        roots: &[PathBuf],
        plan: &Path,
        checkpoint: &Path,
    ) -> Result<()> {
        let mut snapshot = BTreeMap::new();
        for (root_index, root) in roots.iter().enumerate() {
            if !root.exists() {
                continue;
            }
            for entry in WalkDir::new(root).follow_links(false) {
                let entry = entry?;
                if !entry.file_type().is_file() {
                    continue;
                }
                let file = entry.path();
                let text = file.to_string_lossy();
                if root_index == 0
                    && !matches!(
                        file.extension()
                            .and_then(|ext| ext.to_str())
                            .unwrap_or("")
                            .to_ascii_lowercase()
                            .as_str(),
                        "mp4" | "mov" | "mkv" | "avi" | "webm" | "m4v"
                    )
                {
                    continue;
                }
                if text.contains(".invalid-") || text.ends_with(".part") || text.ends_with(".tmp") {
                    continue;
                }
                snapshot.insert(file.to_path_buf(), hash_file(file)?);
            }
        }
        let mut changed = snapshot.clone();
        for step in &mut self.steps {
            step.files.retain(|file, old_hash| {
                if let Some(current_hash) = snapshot.get(file) {
                    *old_hash = current_hash.clone();
                    changed.remove(file);
                    true
                } else {
                    false
                }
            });
        }
        self.steps.push(CompletedStep {
            name,
            files: changed,
        });
        self.plan_hash = hash_file(plan)?;
        write_json_pretty_atomic(checkpoint, self)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn checkpoints_pin_resolution_and_keep_legacy_canvases_resumable() {
        let mut fresh = Checkpoint::default();
        fresh.bind_output_dimensions(3840, 2160, false).unwrap();
        let mut restored: Checkpoint =
            serde_json::from_slice(&serde_json::to_vec(&fresh).unwrap()).unwrap();
        restored.bind_output_dimensions(3840, 2160, true).unwrap();
        assert!(restored.bind_output_dimensions(1920, 1080, true).is_err());
        assert!(restored.bind_output_dimensions(2160, 3840, true).is_err());
        assert!(
            Checkpoint::default()
                .bind_output_dimensions(1280, 720, true)
                .is_err()
        );
        Checkpoint::default()
            .bind_output_dimensions(1080, 1920, true)
            .unwrap();
    }
    #[test]
    fn changed_output_invalidates_its_step_and_downstream_but_keeps_valid_prefix() {
        // 带进程号：两个 `cargo test` 进程并发时只靠时间戳可能撞名
        let root = std::env::temp_dir().join(format!(
            "vacut-checkpoint-{}-{}",
            std::process::id(),
            chrono::Utc::now().timestamp_nanos_opt().unwrap()
        ));
        fs::create_dir_all(root.join("media")).unwrap();
        let plan = root.join("shots.json");
        fs::write(&plan, b"{}").unwrap();
        let journal = root.join("checkpoint.json");
        let roots = vec![root.join("media"), root.join("audio")];
        fs::create_dir_all(root.join("audio")).unwrap();
        let mut cp = Checkpoint::open(&journal, "config", &plan, false).unwrap();
        cp.complete("query".into(), &roots, &plan, &journal)
            .unwrap();
        let video = root.join("media/video.mp4");
        fs::write(&video, b"valid").unwrap();
        cp.complete("download".into(), &roots, &plan, &journal)
            .unwrap();
        let voice = root.join("audio/voice.wav");
        fs::write(&voice, b"voice").unwrap();
        cp.complete("voice".into(), &roots, &plan, &journal)
            .unwrap();
        fs::write(&video, b"corrupt").unwrap();
        let mut cp = Checkpoint::open(&journal, "config", &plan, true).unwrap();
        assert_eq!(
            cp.valid_prefix(&["query".into(), "download".into(), "voice".into()], &roots)
                .unwrap(),
            1
        );
        assert!(!video.exists());
        assert!(!voice.exists());
        assert!(Checkpoint::open(&journal, "different", &plan, true).is_err());
        fs::write(&plan, b"edited").unwrap();
        assert!(Checkpoint::open(&journal, "config", &plan, true).is_err());
        assert!(root.starts_with(std::env::temp_dir()));
        fs::remove_dir_all(root).unwrap();
    }
}
