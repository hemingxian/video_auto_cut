use anyhow::{Context, Result, anyhow, bail};
use serde::Serialize;
use std::ffi::{OsStr, OsString};
use std::fs::{self, File, OpenOptions};
use std::io::{ErrorKind, Write};
use std::path::{Path, PathBuf};

use crate::logging::log_line;

const TEMPORARY_SUFFIX: &str = ".vacut.tmp";
const BACKUP_SUFFIX: &str = ".vacut.bak";

struct SidecarPaths {
    temporary: PathBuf,
    backup: PathBuf,
}

impl SidecarPaths {
    fn for_target(target: &Path) -> Result<Self> {
        let file_name = target
            .file_name()
            .ok_or_else(|| anyhow!("持久化目标缺少文件名: {}", target.display()))?;

        Ok(Self {
            temporary: target.with_file_name(sidecar_name(file_name, TEMPORARY_SUFFIX)),
            backup: target.with_file_name(sidecar_name(file_name, BACKUP_SUFFIX)),
        })
    }
}

fn sidecar_name(file_name: &OsStr, suffix: &str) -> OsString {
    let mut name = OsString::from(".");
    name.push(file_name);
    name.push(suffix);
    name
}

fn parent_directory(target: &Path) -> &Path {
    target
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."))
}

fn regular_file_exists(path: &Path, description: &str) -> Result<bool> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_file() => Ok(true),
        Ok(_) => bail!("{description}不是普通文件: {}", path.display()),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(false),
        Err(error) => {
            Err(error).with_context(|| format!("检查{description}失败: {}", path.display()))
        }
    }
}

fn remove_sidecar_if_present(path: &Path, description: &str) -> Result<()> {
    if !regular_file_exists(path, description)? {
        return Ok(());
    }
    fs::remove_file(path).with_context(|| format!("删除{description}失败: {}", path.display()))
}

fn recover_interrupted_write(target: &Path, sidecars: &SidecarPaths) -> Result<()> {
    let target_exists = regular_file_exists(target, "持久化目标")?;
    if regular_file_exists(&sidecars.backup, "持久化备份")? {
        if target_exists {
            fs::remove_file(&sidecars.backup).with_context(|| {
                format!(
                    "清理已完成写入的残留备份失败: {}",
                    sidecars.backup.display()
                )
            })?;
        } else {
            fs::rename(&sidecars.backup, target).with_context(|| {
                format!(
                    "恢复中断写入的旧文件失败: {} -> {}",
                    sidecars.backup.display(),
                    target.display()
                )
            })?;
            sync_parent_directory(parent_directory(target))?;
        }
    }

    remove_sidecar_if_present(&sidecars.temporary, "持久化临时文件")
}

pub(crate) fn write_bytes_atomic(target: &Path, bytes: &[u8]) -> Result<()> {
    write_atomic_with(target, |file| file.write_all(bytes))
}

pub(crate) fn write_json_pretty_atomic<T>(target: &Path, value: &T) -> Result<()>
where
    T: Serialize + ?Sized,
{
    let payload = serde_json::to_vec_pretty(value)?;
    write_bytes_atomic(target, &payload)
}

fn write_atomic_with(
    target: &Path,
    writer: impl FnOnce(&mut File) -> std::io::Result<()>,
) -> Result<()> {
    let parent = parent_directory(target);
    fs::create_dir_all(parent)
        .with_context(|| format!("创建持久化目录失败: {}", parent.display()))?;

    let sidecars = SidecarPaths::for_target(target)?;
    recover_interrupted_write(target, &sidecars)?;

    let mut temporary_file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&sidecars.temporary)
        .with_context(|| format!("创建持久化临时文件失败: {}", sidecars.temporary.display()))?;

    let write_result = (|| -> Result<()> {
        writer(&mut temporary_file)
            .with_context(|| format!("写入持久化临时文件失败: {}", sidecars.temporary.display()))?;
        temporary_file
            .flush()
            .with_context(|| format!("刷新持久化临时文件失败: {}", sidecars.temporary.display()))?;
        temporary_file
            .sync_all()
            .with_context(|| format!("同步持久化临时文件失败: {}", sidecars.temporary.display()))?;
        Ok(())
    })();
    drop(temporary_file);

    if let Err(error) = write_result {
        let _ = fs::remove_file(&sidecars.temporary);
        return Err(error);
    }

    let install_result = install_prepared_file(target, &sidecars, || Ok(()));
    if install_result.is_err() {
        let _ = fs::remove_file(&sidecars.temporary);
    }
    install_result
}

fn install_prepared_file(
    target: &Path,
    sidecars: &SidecarPaths,
    after_backup: impl FnOnce() -> Result<()>,
) -> Result<()> {
    if !regular_file_exists(&sidecars.temporary, "待安装临时文件")? {
        bail!("待安装临时文件不存在: {}", sidecars.temporary.display());
    }

    if !regular_file_exists(target, "持久化目标")? {
        fs::rename(&sidecars.temporary, target).with_context(|| {
            format!(
                "安装新文件失败: {} -> {}",
                sidecars.temporary.display(),
                target.display()
            )
        })?;
        sync_parent_directory(parent_directory(target))?;
        return Ok(());
    }

    remove_sidecar_if_present(&sidecars.backup, "持久化备份")?;
    fs::rename(target, &sidecars.backup).with_context(|| {
        format!(
            "备份旧文件失败: {} -> {}",
            target.display(),
            sidecars.backup.display()
        )
    })?;

    let install_result = after_backup().and_then(|()| {
        fs::rename(&sidecars.temporary, target).with_context(|| {
            format!(
                "安装替换文件失败: {} -> {}",
                sidecars.temporary.display(),
                target.display()
            )
        })
    });

    if let Err(install_error) = install_result {
        return match fs::rename(&sidecars.backup, target) {
            Ok(()) => {
                sync_parent_directory(parent_directory(target))?;
                Err(install_error).context("替换文件失败，旧文件已恢复")
            }
            Err(restore_error) => bail!(
                "替换文件失败且恢复旧文件失败；旧内容仍保留在 {}。安装错误: {install_error:#}；恢复错误: {restore_error}",
                sidecars.backup.display()
            ),
        };
    }

    sync_parent_directory(parent_directory(target))?;
    if let Err(error) = fs::remove_file(&sidecars.backup) {
        let warning = format!(
            "新文件已安装，但清理旧文件备份失败（下次写入会重试）: {}: {error}",
            sidecars.backup.display()
        );
        eprintln!("[警告] {warning}");
        log_line(warning);
    }

    Ok(())
}

#[cfg(unix)]
fn sync_parent_directory(parent: &Path) -> Result<()> {
    File::open(parent)
        .and_then(|directory| directory.sync_all())
        .with_context(|| format!("同步持久化目录失败: {}", parent.display()))
}

#[cfg(not(unix))]
fn sync_parent_directory(_parent: &Path) -> Result<()> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    struct TestDirectory(PathBuf);

    impl TestDirectory {
        fn new(label: &str) -> Self {
            let nonce = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|duration| duration.as_nanos())
                .unwrap_or_default();
            let path = std::env::temp_dir().join(format!(
                "video_auto_persistence_{label}_{}_{nonce}",
                std::process::id()
            ));
            fs::create_dir_all(&path).expect("create test directory");
            Self(path)
        }
    }

    impl Drop for TestDirectory {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn successful_overwrite_replaces_content_and_cleans_sidecars() {
        let directory = TestDirectory::new("overwrite");
        let target = directory.0.join("state.json");
        let sidecars = SidecarPaths::for_target(&target).expect("derive sidecar paths");
        fs::write(&target, b"old").expect("write old target");
        fs::write(&sidecars.temporary, b"stale temporary").expect("write stale temporary");
        fs::write(&sidecars.backup, b"stale backup").expect("write stale backup");

        write_bytes_atomic(&target, b"new").expect("overwrite target");

        assert_eq!(fs::read(&target).expect("read target"), b"new");
        assert!(!sidecars.temporary.exists());
        assert!(!sidecars.backup.exists());
    }

    #[test]
    fn pretty_json_format_matches_serde_pretty_output_without_trailing_newline() {
        let directory = TestDirectory::new("json_format");
        let target = directory.0.join("state.json");
        let value = serde_json::json!({ "name": "demo", "count": 2 });

        write_json_pretty_atomic(&target, &value).expect("write JSON");

        assert_eq!(
            fs::read_to_string(&target).expect("read JSON"),
            serde_json::to_string_pretty(&value).expect("serialize expected JSON")
        );
    }

    #[test]
    fn write_failure_keeps_old_file_and_removes_partial_temporary_file() {
        let directory = TestDirectory::new("write_failure");
        let target = directory.0.join("state.json");
        let sidecars = SidecarPaths::for_target(&target).expect("derive sidecar paths");
        fs::write(&target, b"old").expect("write old target");

        let result = write_atomic_with(&target, |file| {
            file.write_all(b"partial")?;
            Err(std::io::Error::other("injected write failure"))
        });

        assert!(result.is_err());
        assert_eq!(fs::read(&target).expect("read target"), b"old");
        assert!(!sidecars.temporary.exists());
        assert!(!sidecars.backup.exists());
    }

    #[test]
    fn install_failure_restores_old_file_to_original_path() {
        let directory = TestDirectory::new("install_failure");
        let target = directory.0.join("state.json");
        let sidecars = SidecarPaths::for_target(&target).expect("derive sidecar paths");
        fs::write(&target, b"old").expect("write old target");
        fs::write(&sidecars.temporary, b"new").expect("write temporary file");

        let result = install_prepared_file(&target, &sidecars, || {
            fs::remove_file(&sidecars.temporary)?;
            Ok(())
        });

        assert!(result.is_err());
        assert_eq!(fs::read(&target).expect("read restored target"), b"old");
        assert!(!sidecars.backup.exists());
    }

    #[test]
    fn recovery_restores_backup_and_discards_incomplete_temporary_file() {
        let directory = TestDirectory::new("recovery");
        let target = directory.0.join("state.json");
        let sidecars = SidecarPaths::for_target(&target).expect("derive sidecar paths");
        fs::write(&sidecars.backup, b"old").expect("write backup");
        fs::write(&sidecars.temporary, b"partial new").expect("write temporary file");

        recover_interrupted_write(&target, &sidecars).expect("recover interrupted write");

        assert_eq!(fs::read(&target).expect("read restored target"), b"old");
        assert!(!sidecars.backup.exists());
        assert!(!sidecars.temporary.exists());
    }
}
