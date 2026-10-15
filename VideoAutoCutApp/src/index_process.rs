//! Bounded streaming and workload-based budgets, used only for material indexing.
use anyhow::{Context, Result, bail};
use regex::Regex;
use std::collections::HashMap;
use std::io::{self, Read, Write};
use std::process::{Command, Stdio};
use std::sync::{LazyLock, mpsc};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use super::process_tree::{ProcessTree, cancel_reader};
use crate::logging::log_line;

const POLL: Duration = Duration::from_millis(50);
const DRAIN_GRACE: Duration = Duration::from_secs(2);
const MAX_LINE_BYTES: usize = 16 * 1024;
const QUEUED_LINES: usize = 64;
const HARD_MAX_SECONDS: u64 = 24 * 60 * 60;

#[derive(Debug, Default)]
struct FileProgress {
    chunk: u64,
    completed: u64,
    cached: u64,
    complete: bool,
    phase: String,
}

#[derive(Debug)]
pub(crate) struct IndexBudget {
    files: u64,
    chunks: HashMap<u64, u64>,
    progress: HashMap<u64, FileProgress>,
    current_file: Option<u64>,
    startup_seconds: u64,
    file_seconds: u64,
    chunk_seconds: u64,
    cap: Duration,
    fixed: Option<Duration>,
    heartbeat: Duration,
}

fn env_seconds(name: &str, fallback: u64, minimum: u64, maximum: u64) -> u64 {
    parse_seconds(
        std::env::var(name).ok().as_deref(),
        fallback,
        minimum,
        maximum,
    )
}

fn parse_seconds(value: Option<&str>, fallback: u64, minimum: u64, maximum: u64) -> u64 {
    value
        .and_then(|value| value.trim().parse::<f64>().ok())
        .filter(|value| value.is_finite() && *value > 0.0)
        .map(|value| value.ceil() as u64)
        .unwrap_or(fallback)
        .clamp(minimum, maximum)
}

fn minimum_chunk_seconds(step: u64, attempt: u64) -> u64 {
    // Python performs at most four ffmpeg steps, three attempts with <=60s rate waits,
    // 2+4s retry backoff, a 30s probe and 30s of bookkeeping allowance per chunk.
    step.saturating_mul(4)
        .saturating_add(attempt.saturating_add(60).saturating_mul(3))
        .saturating_add(66)
}

impl IndexBudget {
    pub(crate) fn configured(files: usize) -> Self {
        let cap = Duration::from_secs(env_seconds(
            "SENTRY_INDEX_MAX_TIMEOUT_SECONDS",
            12 * 60 * 60,
            60,
            HARD_MAX_SECONDS,
        ));
        let fixed = std::env::var("SENTRY_INDEX_TIMEOUT_SECONDS")
            .ok()
            .and_then(|value| value.parse::<u64>().ok())
            .filter(|value| *value > 0)
            .map(|seconds| Duration::from_secs(seconds.max(60)).min(cap));
        let chunk_floor = minimum_chunk_seconds(
            env_seconds("VIDEOAUTO_INDEX_STEP_TIMEOUT_SECONDS", 300, 1, 1800),
            env_seconds("VIDEOAUTO_QWEN_ATTEMPT_TIMEOUT_SECONDS", 180, 1, 1800),
        );
        Self {
            files: (files as u64).max(1),
            chunks: HashMap::new(),
            progress: HashMap::new(),
            current_file: None,
            startup_seconds: 180,
            file_seconds: env_seconds("SENTRY_INDEX_FILE_TIMEOUT_SECONDS", 60, 5, 600),
            // A per-chunk override can add allowance, but cannot undercut configured child timeouts.
            chunk_seconds: env_seconds(
                "SENTRY_INDEX_CHUNK_TIMEOUT_SECONDS",
                chunk_floor,
                chunk_floor,
                HARD_MAX_SECONDS,
            ),
            cap,
            fixed,
            heartbeat: Duration::from_secs(env_seconds(
                "SENTRY_INDEX_HEARTBEAT_SECONDS",
                10,
                1,
                60,
            )),
        }
    }

    fn workload_seconds(&self) -> u64 {
        // Reserve four chunks per unknown file. Actual totals may only extend this estimate.
        let extra_chunks = self
            .chunks
            .values()
            .map(|count| count.saturating_sub(4))
            .fold(0_u64, u64::saturating_add);
        self.startup_seconds
            .saturating_add(self.files.saturating_mul(self.file_seconds))
            .saturating_add(
                self.files
                    .saturating_mul(4)
                    .saturating_add(extra_chunks)
                    .saturating_mul(self.chunk_seconds),
            )
    }

    fn limit(&self) -> Duration {
        self.fixed
            .unwrap_or_else(|| Duration::from_secs(self.workload_seconds()))
            .min(self.cap)
    }

    fn limit_kind(&self) -> &'static str {
        if self.limit() == self.cap {
            "索引总时长硬上限"
        } else if self.fixed.is_some() {
            "配置的索引总时长预算"
        } else {
            "按文件与分块计算的索引预算"
        }
    }

    fn progress_text(&self) -> String {
        let Some(file) = self.current_file else {
            return "等待索引进程报告文件与分块进度".into();
        };
        let Some(progress) = self.progress.get(&file) else {
            return format!("文件 {file}/{}", self.files);
        };
        let chunks = self.chunks.get(&file).copied().unwrap_or(0);
        let phase = match progress.phase.as_str() {
            "probe" => "读取视频信息",
            "cache" => "检查缓存",
            "split" => "分块处理",
            "still" => "检查静帧",
            "preprocess" => "预处理",
            "embedding" => "模型分析",
            "chunk_complete" => "分块完成",
            "complete" => "文件完成",
            "failed" => "文件失败",
            _ => "处理中",
        };
        let completed_files = self.progress.values().filter(|item| item.complete).count();
        let completed = self
            .progress
            .values()
            .map(|item| item.completed)
            .sum::<u64>();
        let cached = self.progress.values().map(|item| item.cached).sum::<u64>();
        format!(
            "文件 {file}/{}，{phase}，当前分块 {}/{}；当前文件完成 {}/{}（缓存 {}）；累计完成 {completed_files} 个文件、{completed} 个分块（缓存 {cached}）",
            self.files, progress.chunk, chunks, progress.completed, chunks, progress.cached
        )
    }

    fn observe(&mut self, line: &str) {
        static LEGACY: LazyLock<Regex> = LazyLock::new(|| {
            Regex::new(r"Indexing file\s+(\d+)/(\d+):.*\[chunk\s+\d+/(\d+)\]").unwrap()
        });
        let data = line
            .split_once("VACUT_INDEX_PROGRESS:")
            .and_then(|(_, text)| serde_json::from_str::<serde_json::Value>(text.trim()).ok());
        let counts = data
            .as_ref()
            .and_then(|data| {
                Some((
                    data["file"].as_u64()?,
                    data["files"].as_u64()?,
                    data["chunks"].as_u64()?,
                ))
            })
            .or_else(|| {
                let captures = LEGACY.captures(line)?;
                Some((
                    captures[1].parse().ok()?,
                    captures[2].parse().ok()?,
                    captures[3].parse().ok()?,
                ))
            });
        if let Some((file, files, chunks)) = counts {
            if file == 0 || file > files || files > 100_000 || chunks > 1_000_000 {
                return;
            }
            self.files = self.files.max(files);
            self.chunks
                .entry(file)
                .and_modify(|current| *current = (*current).max(chunks))
                .or_insert(chunks);
            self.current_file = Some(file);
            let progress = self.progress.entry(file).or_default();
            if let Some(data) = data {
                let maximum = self.chunks[&file];
                if let Some(chunk) = data["chunk"].as_u64().filter(|chunk| *chunk <= maximum) {
                    progress.chunk = chunk;
                }
                if let Some(completed) = data["completed_chunks"]
                    .as_u64()
                    .filter(|count| *count <= maximum)
                {
                    progress.completed = progress.completed.max(completed);
                }
                if let Some(cached) = data["cached_chunks"]
                    .as_u64()
                    .filter(|count| *count <= progress.completed)
                {
                    progress.cached = progress.cached.max(cached);
                }
                if let Some(phase) = data["phase"].as_str().filter(|phase| phase.len() <= 32) {
                    progress.phase = phase.into();
                    progress.complete |= phase == "complete";
                }
            }
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Source {
    Stdout,
    Stderr,
    Heartbeat,
}
struct Line {
    source: Source,
    text: String,
}
struct PipeReader(Option<JoinHandle<io::Result<()>>>);

impl PipeReader {
    fn spawn(
        mut pipe: impl Read + Send + 'static,
        source: Source,
        sender: mpsc::SyncSender<Line>,
    ) -> Self {
        Self(Some(thread::spawn(move || {
            let mut buffer = Vec::with_capacity(MAX_LINE_BYTES);
            let mut chunk = [0_u8; 4096];
            loop {
                let count = pipe.read(&mut chunk)?;
                for &byte in &chunk[..count] {
                    if byte == b'\n' || byte == b'\r' {
                        if !buffer.is_empty() {
                            if sender
                                .send(Line {
                                    source,
                                    text: String::from_utf8_lossy(&buffer).into_owned(),
                                })
                                .is_err()
                            {
                                return Ok(());
                            }
                            buffer.clear();
                        }
                    } else {
                        buffer.push(byte);
                        if buffer.len() == MAX_LINE_BYTES {
                            if sender
                                .send(Line {
                                    source,
                                    text: String::from_utf8_lossy(&buffer).into_owned(),
                                })
                                .is_err()
                            {
                                return Ok(());
                            }
                            buffer.clear();
                        }
                    }
                }
                if count == 0 {
                    if !buffer.is_empty() {
                        let _ = sender.send(Line {
                            source,
                            text: String::from_utf8_lossy(&buffer).into_owned(),
                        });
                    }
                    return Ok(());
                }
            }
        })))
    }
    fn is_finished(&self) -> bool {
        self.0.as_ref().is_none_or(JoinHandle::is_finished)
    }
    fn finish(&mut self) -> Result<()> {
        if let Some(reader) = self.0.take() {
            reader
                .join()
                .map_err(|_| anyhow::anyhow!("索引输出读取线程异常"))??;
        }
        Ok(())
    }
}
impl Drop for PipeReader {
    fn drop(&mut self) {
        if let Some(reader) = self.0.as_ref().filter(|thread| !thread.is_finished()) {
            cancel_reader(reader);
        }
    }
}

fn forward_line(line: &Line) {
    let text = format!("{}\n", line.text);
    if line.source == Source::Stderr {
        let _ = io::stderr().lock().write_all(text.as_bytes());
        let _ = io::stderr().flush();
        log_line(format!("stderr: {}", line.text));
    } else {
        let _ = io::stdout().lock().write_all(text.as_bytes());
        let _ = io::stdout().flush();
        log_line(format!("stdout: {}", line.text));
    }
}

pub(crate) fn run_index_streaming(
    command: &mut Command,
    label: &str,
    budget: IndexBudget,
) -> Result<()> {
    run_streaming(command, label, budget, forward_line)
}

fn run_streaming(
    command: &mut Command,
    label: &str,
    mut budget: IndexBudget,
    mut emit: impl FnMut(&Line),
) -> Result<()> {
    // Index Python and its workers must flush even when stdout is piped to the desktop.
    command
        .env("PYTHONUNBUFFERED", "1")
        .env("PYTHONIOENCODING", "utf-8")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    emit(&Line {
        source: Source::Heartbeat,
        text: format!(
            ">>> {label}：待检查 {} 个文件，{} {} 秒（上限 {} 秒；每块预留 {} 秒）",
            budget.files,
            budget.limit_kind(),
            budget.limit().as_secs(),
            budget.cap.as_secs(),
            budget.chunk_seconds
        ),
    });
    let (mut child, tree) =
        ProcessTree::spawn(command).with_context(|| format!("启动索引进程树失败: {label}"))?;
    let (sender, receiver) = mpsc::sync_channel(QUEUED_LINES);
    let mut stdout = PipeReader::spawn(
        child.stdout.take().context("索引标准输出管道缺失")?,
        Source::Stdout,
        sender.clone(),
    );
    let mut stderr = PipeReader::spawn(
        child.stderr.take().context("索引错误输出管道缺失")?,
        Source::Stderr,
        sender,
    );
    let started = Instant::now();
    let mut heartbeat_at = budget.heartbeat;
    let mut status = None;
    let mut timed_out = false;
    loop {
        // A chatty child cannot indefinitely postpone the timeout check.
        for _ in 0..QUEUED_LINES {
            let Ok(line) = receiver.try_recv() else {
                break;
            };
            budget.observe(&line.text);
            emit(&line);
        }
        let elapsed = started.elapsed();
        if let Some(exit) = child.try_wait()? {
            status = Some(exit);
            break;
        }
        if elapsed >= budget.limit() {
            timed_out = true;
            break;
        }
        if elapsed >= heartbeat_at {
            emit(&Line {
                source: Source::Heartbeat,
                text: format!(
                    "索引仍在处理：已运行 {} 秒，{} {} 秒；{}",
                    elapsed.as_secs(),
                    budget.limit_kind(),
                    budget.limit().as_secs(),
                    budget.progress_text()
                ),
            });
            heartbeat_at = elapsed.saturating_add(budget.heartbeat);
        }
        thread::sleep(POLL.min(budget.limit().saturating_sub(elapsed)));
    }

    // Keep the deadline that actually expired: final queued progress may extend the estimate
    // while we drain output after termination, but must not rewrite the timeout explanation.
    let expired_limit = budget.limit();
    let expired_kind = budget.limit_kind();
    // Also close surviving workers after the parent exits, so inherited pipe handles cannot hang us.
    if let Err(error) = tree.terminate() {
        let _ = child.kill();
        emit(&Line {
            source: Source::Stderr,
            text: format!("索引进程树清理失败：{error}"),
        });
    }
    let drain_started = Instant::now();
    loop {
        for _ in 0..QUEUED_LINES {
            let Ok(line) = receiver.try_recv() else {
                break;
            };
            budget.observe(&line.text);
            emit(&line);
        }
        if stdout.is_finished()
            && stderr.is_finished()
            && receiver.try_iter().inspect(|line| emit(line)).count() == 0
        {
            break;
        }
        if drain_started.elapsed() >= DRAIN_GRACE {
            emit(&Line {
                source: Source::Stderr,
                text: "索引输出管道关闭超时，已取消读取并清理进程树".into(),
            });
            break;
        }
        let _ = child.try_wait();
        thread::sleep(POLL);
    }
    let readers_finished = stdout.is_finished() && stderr.is_finished();
    let read_result = if readers_finished {
        stdout.finish().and(stderr.finish())
    } else {
        Ok(())
    };
    if timed_out {
        let message = format!(
            "索引超时: {label}，已运行 {} 秒，触及{} {} 秒；{}；已终止索引进程树，可继续任务复用已完成索引",
            started.elapsed().as_secs(),
            expired_kind,
            expired_limit.as_secs(),
            budget.progress_text()
        );
        emit(&Line {
            source: Source::Stderr,
            text: message.clone(),
        });
        bail!(message);
    }
    read_result.context("索引输出读取失败")?;
    if !readers_finished {
        bail!("索引输出管道关闭超时: {label}");
    }
    let status = status.context("索引进程未返回退出状态")?;
    if !status.success() {
        bail!("索引命令失败: {label}，退出码 {:?}", status.code());
    }
    emit(&Line {
        source: Source::Heartbeat,
        text: format!("索引完成：{label}，用时 {} 秒", started.elapsed().as_secs()),
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::env;
    use std::fs;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};
    const MODE: &str = "VIDEOAUTO_INDEX_PROCESS_TEST_MODE";
    const DIRECTORY: &str = "VIDEOAUTO_INDEX_PROCESS_TEST_DIR";

    fn child_command(mode: &str) -> Command {
        let mut command = Command::new(env::current_exe().unwrap());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(windows_sys::Win32::System::Threading::CREATE_NO_WINDOW);
        }
        command
            .args([
                "--exact",
                "process::index_process::tests::child_fixture",
                "--nocapture",
            ])
            .env(MODE, mode);
        command
    }
    fn short_budget(milliseconds: u64) -> IndexBudget {
        IndexBudget {
            files: 1,
            chunks: HashMap::new(),
            progress: HashMap::new(),
            current_file: None,
            startup_seconds: 180,
            file_seconds: 60,
            chunk_seconds: 90,
            cap: Duration::from_secs(12 * 60 * 60),
            fixed: Some(Duration::from_millis(milliseconds)),
            heartbeat: Duration::from_millis(100),
        }
    }
    #[test]
    fn child_fixture() {
        match env::var(MODE).as_deref() {
            Ok("output") => {
                println!("INDEX-REAL-STDOUT");
                eprintln!("INDEX-REAL-STDERR");
                print!("INDEX-CR-PROGRESS\r");
                println!(
                    "VACUT_INDEX_PROGRESS:{{\"file\":2,\"files\":74,\"chunks\":12,\"chunk\":4,\"completed_chunks\":3,\"cached_chunks\":2,\"phase\":\"embedding\"}}"
                );
                io::stdout().flush().unwrap();
                thread::sleep(Duration::from_millis(600));
                print!("INDEX-TRAILING-LINE");
            }
            Ok("sleep") => thread::sleep(Duration::from_secs(30)),
            Ok("tree-host") => {
                run_index_streaming(
                    &mut child_command("descendant"),
                    "pause host fixture",
                    short_budget(30_000),
                )
                .unwrap();
            }
            Ok("descendant") | Ok("orphan-pipe") => {
                let child = child_command("sleep").spawn().unwrap();
                println!("INDEX-DESCENDANT-PID:{}", child.id());
                io::stdout().flush().unwrap();
                if env::var(MODE).unwrap() == "descendant" {
                    thread::sleep(Duration::from_secs(30));
                }
                // Dropping Child deliberately leaves a live descendant holding stdout/stderr.
                drop(child);
            }
            Ok("long-output") => {
                io::stdout()
                    .write_all(&vec![b'x'; MAX_LINE_BYTES * 128 + 3])
                    .unwrap();
                io::stderr()
                    .write_all(&vec![b'y'; MAX_LINE_BYTES * 8 + 7])
                    .unwrap();
            }
            Ok("logging") => {
                let directory = PathBuf::from(env::var_os(DIRECTORY).unwrap());
                fs::create_dir_all(directory.join("run")).unwrap();
                crate::logging::init_run_log(&directory, &directory.join("run")).unwrap();
                run_index_streaming(
                    &mut child_command("output"),
                    "index log fixture",
                    short_budget(5_000),
                )
                .unwrap();
            }
            _ => {}
        }
    }
    #[test]
    fn stdout_stderr_cr_and_trailing_output_are_forwarded_before_exit_with_heartbeat() {
        let started = Instant::now();
        let mut observed = Vec::new();
        run_streaming(
            &mut child_command("output"),
            "stream fixture",
            short_budget(5_000),
            |line| {
                observed.push((line.source, line.text.clone(), started.elapsed()));
            },
        )
        .unwrap();
        assert!(
            observed
                .iter()
                .any(|(source, text, at)| *source == Source::Stdout
                    && text == "INDEX-REAL-STDOUT"
                    && *at < Duration::from_millis(600))
        );
        assert!(
            observed
                .iter()
                .any(|(source, text, at)| *source == Source::Stderr
                    && text == "INDEX-REAL-STDERR"
                    && *at < Duration::from_millis(600))
        );
        assert!(
            observed
                .iter()
                .any(|(_, text, _)| text == "INDEX-CR-PROGRESS")
        );
        assert!(
            observed
                .iter()
                .any(|(_, text, _)| text.contains("INDEX-TRAILING-LINE"))
        );
        assert!(
            observed
                .iter()
                .any(|(source, text, _)| *source == Source::Heartbeat && text.contains("已运行"))
        );
        assert!(
            observed
                .iter()
                .any(|(source, text, _)| *source == Source::Heartbeat
                    && text.contains("文件 2/74")
                    && text.contains("完成 3/12（缓存 2）"))
        );
    }
    #[test]
    fn oversized_unterminated_output_has_bounded_line_buffers_and_preserves_all_bytes() {
        let mut bytes = 0;
        run_streaming(
            &mut child_command("long-output"),
            "bounded stream fixture",
            short_budget(10_000),
            |line| {
                if line.source != Source::Heartbeat {
                    assert!(line.text.len() <= MAX_LINE_BYTES);
                    bytes += line
                        .text
                        .bytes()
                        .filter(|byte| *byte == b'x' || *byte == b'y')
                        .count();
                }
            },
        )
        .unwrap();
        assert!(bytes >= MAX_LINE_BYTES * 136 + 10);
    }
    #[cfg(windows)]
    fn process_alive(pid: u32) -> bool {
        use windows_sys::Win32::Foundation::CloseHandle;
        use windows_sys::Win32::System::Threading::{
            GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
        };
        let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
        if handle.is_null() {
            return false;
        }
        let mut exit = 0;
        let alive = unsafe { GetExitCodeProcess(handle, &mut exit) } != 0 && exit == 259;
        unsafe {
            CloseHandle(handle);
        }
        alive
    }
    #[test]
    #[cfg(windows)]
    fn timeout_and_parent_exit_kill_real_pipe_holding_descendants() {
        for mode in ["descendant", "orphan-pipe"] {
            let started = Instant::now();
            let mut pid = None;
            let result = run_streaming(
                &mut child_command(mode),
                "tree fixture",
                short_budget(400),
                |line| {
                    if let Some(value) = line.text.strip_prefix("INDEX-DESCENDANT-PID:") {
                        pid = Some(value.parse::<u32>().unwrap());
                    }
                },
            );
            if mode == "descendant" {
                assert!(result.unwrap_err().to_string().contains("索引超时"));
            } else {
                result.unwrap();
            }
            assert!(started.elapsed() < Duration::from_secs(3));
            let pid = pid.expect("child must emit its descendant PID");
            let reap_started = Instant::now();
            while process_alive(pid) && reap_started.elapsed() < Duration::from_secs(1) {
                thread::sleep(POLL);
            }
            assert!(!process_alive(pid), "descendant {pid} survived cleanup");
        }
    }
    #[test]
    #[cfg(windows)]
    fn killing_the_engine_host_for_pause_closes_the_job_and_terminates_descendants() {
        use std::io::BufRead;
        // The outer host deliberately has no Job: only its own index Job can clean its workers.
        let mut host = child_command("tree-host")
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let pipe = host.stdout.take().unwrap();
        let (sender, receiver) = mpsc::channel();
        let reader = thread::spawn(move || {
            for line in io::BufReader::new(pipe).lines().map_while(Result::ok) {
                if let Some(pid) = line.strip_prefix("INDEX-DESCENDANT-PID:") {
                    let _ = sender.send(pid.parse::<u32>().unwrap());
                }
            }
        });
        let pid = receiver.recv_timeout(Duration::from_secs(5));
        host.kill().unwrap();
        let started = Instant::now();
        while host.try_wait().unwrap().is_none() && started.elapsed() < Duration::from_secs(2) {
            thread::sleep(POLL);
        }
        let pid = pid.expect("host must forward descendant PID before pause");
        while process_alive(pid) && started.elapsed() < Duration::from_secs(2) {
            thread::sleep(POLL);
        }
        assert!(
            !process_alive(pid),
            "host pause left descendant {pid} alive"
        );
        while !reader.is_finished() && started.elapsed() < Duration::from_secs(2) {
            thread::sleep(POLL);
        }
        assert!(reader.is_finished(), "pause left a pipe reader blocked");
        reader.join().unwrap();
    }
    #[test]
    fn fresh_attempt_gets_a_fresh_budget_after_a_stopped_or_timed_out_attempt() {
        assert!(
            run_streaming(
                &mut child_command("sleep"),
                "first attempt",
                short_budget(150),
                |_| {}
            )
            .is_err()
        );
        thread::sleep(Duration::from_millis(200));
        run_streaming(
            &mut child_command("output"),
            "continued attempt",
            short_budget(2_000),
            |_| {},
        )
        .unwrap();
    }
    #[test]
    fn workload_budget_expands_for_actual_chunks_never_shrinks_and_has_a_hard_ceiling() {
        let mut budget = short_budget(1);
        budget.fixed = None;
        budget.files = 74;
        let initial = budget.limit();
        assert!(initial > Duration::from_secs(60 * 60));
        budget.observe(
            "VACUT_INDEX_PROGRESS:{\"file\":1,\"files\":74,\"chunks\":120,\"phase\":\"embedding\"}",
        );
        assert!(budget.limit() > initial);
        let expanded = budget.limit();
        budget.observe("Indexing file 1/74: source.mp4 [chunk 1/2]");
        assert_eq!(budget.limit(), expanded);
        budget.observe("Indexing file 2/74: source.mp4 [chunk 1/1000000]");
        assert_eq!(budget.limit(), budget.cap);
        budget.fixed = Some(Duration::from_secs(500));
        assert_eq!(budget.limit(), Duration::from_secs(500));
    }
    #[test]
    fn configured_workload_allowance_covers_all_bounded_child_attempts_and_preprocessing() {
        assert_eq!(minimum_chunk_seconds(300, 180), 1986);
        assert_eq!(minimum_chunk_seconds(1800, 1800), 12846);
        assert_eq!(parse_seconds(Some("180.1"), 180, 1, 1800), 181);
        for value in ["NaN", "inf", "invalid", "0", "-3"] {
            assert_eq!(parse_seconds(Some(value), 180, 1, 1800), 180);
        }
        let mut budget = short_budget(1);
        budget.fixed = None;
        budget.chunk_seconds = minimum_chunk_seconds(300, 180);
        assert_eq!(budget.limit(), Duration::from_secs(180 + 60 + 4 * 1986));
        assert_eq!(budget.limit_kind(), "按文件与分块计算的索引预算");
        budget.observe("VACUT_INDEX_PROGRESS:{\"file\":1,\"files\":1,\"chunks\":12}");
        assert_eq!(budget.limit(), Duration::from_secs(180 + 60 + 12 * 1986));
        budget.files = 74;
        assert_eq!(budget.limit(), budget.cap);
        assert_eq!(budget.limit_kind(), "索引总时长硬上限");
        budget.fixed = Some(Duration::from_secs(500));
        assert_eq!(budget.limit_kind(), "配置的索引总时长预算");
    }
    #[test]
    fn progress_uses_only_reported_completion_and_cache_counts_and_aggregates_files() {
        let mut budget = short_budget(10_000);
        budget.observe("VACUT_INDEX_PROGRESS:{\"file\":1,\"files\":74,\"chunks\":12,\"chunk\":12,\"phase\":\"embedding\"}");
        assert!(budget.progress_text().contains("完成 0/12（缓存 0）"));
        budget.observe("VACUT_INDEX_PROGRESS:{\"file\":1,\"files\":74,\"chunks\":12,\"chunk\":12,\"completed_chunks\":12,\"cached_chunks\":10,\"phase\":\"complete\"}");
        budget.observe("VACUT_INDEX_PROGRESS:{\"file\":2,\"files\":74,\"chunks\":4,\"chunk\":2,\"completed_chunks\":1,\"cached_chunks\":1,\"phase\":\"chunk_complete\"}");
        assert!(
            budget
                .progress_text()
                .contains("累计完成 1 个文件、13 个分块（缓存 11）")
        );
        let before = budget.progress_text();
        budget.observe("VACUT_INDEX_PROGRESS:{\"file\":0,\"files\":999999,\"chunks\":9999999}");
        assert_eq!(budget.progress_text(), before);
    }
    #[test]
    fn real_forwarding_writes_stdout_stderr_and_heartbeat_to_run_log() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let directory = env::temp_dir().join(format!(
            "videoauto_index_process_test_{}_{}",
            std::process::id(),
            nonce
        ));
        fs::create_dir_all(&directory).unwrap();
        let mut command = child_command("logging");
        command.env(DIRECTORY, &directory);
        run_streaming(&mut command, "logging child", short_budget(10_000), |_| {}).unwrap();
        let log = fs::read_to_string(directory.join("run/run.log")).unwrap();
        assert!(log.contains("INDEX-REAL-STDOUT"));
        assert!(log.contains("INDEX-REAL-STDERR"));
        assert!(log.contains("索引仍在处理"));
        assert!(directory.starts_with(env::temp_dir()));
        fs::remove_dir_all(directory).unwrap();
    }
}
