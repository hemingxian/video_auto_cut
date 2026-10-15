use anyhow::{Context, Result, bail};
use std::io::{self, Read};
use std::process::{Command, ExitStatus, Output, Stdio};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use crate::logging::{log_line, log_text};

#[path = "index_process.rs"]
mod index_process;
#[path = "process_tree.rs"]
mod process_tree;
pub(crate) use index_process::{IndexBudget, run_index_streaming};

const PROCESS_POLL_INTERVAL: Duration = Duration::from_millis(50);
const PROCESS_TERMINATION_GRACE: Duration = Duration::from_secs(2);

struct CapturedPipe {
    bytes: Arc<Mutex<Vec<u8>>>,
    reader: Option<JoinHandle<io::Result<()>>>,
}

impl CapturedPipe {
    fn spawn(mut pipe: impl Read + Send + 'static) -> Self {
        let bytes = Arc::new(Mutex::new(Vec::new()));
        let writer = Arc::clone(&bytes);
        let reader = thread::spawn(move || {
            let mut chunk = [0_u8; 8192];
            loop {
                let count = pipe.read(&mut chunk)?;
                if count == 0 {
                    return Ok(());
                }
                writer
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner())
                    .extend_from_slice(&chunk[..count]);
            }
        });
        Self {
            bytes,
            reader: Some(reader),
        }
    }

    fn is_finished(&self) -> bool {
        self.reader.as_ref().is_none_or(JoinHandle::is_finished)
    }

    fn snapshot(&self) -> Vec<u8> {
        self.bytes
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
    }

    fn finish(mut self) -> io::Result<Vec<u8>> {
        if let Some(reader) = self.reader.take() {
            reader
                .join()
                .map_err(|_| io::Error::other("命令输出读取线程异常退出"))??;
        }
        Ok(self.snapshot())
    }
}

pub(crate) fn run_command(cmd: &mut Command, label: &str) -> Result<()> {
    log_command_start(cmd, label);

    let status = cmd
        .stdin(Stdio::inherit())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit())
        .status()
        .with_context(|| format!("启动命令失败: {}", label))?;

    if !status.success() {
        log_line(format!("命令失败: {}, 退出码: {:?}", label, status.code()));
        bail!("命令执行失败: {}, 退出码: {:?}", label, status.code());
    }

    log_line(format!("命令完成: {}, 退出码: {:?}", label, status.code()));
    Ok(())
}

pub(crate) fn run_command_timeout(cmd: &mut Command, label: &str, timeout: Duration) -> Result<()> {
    log_command_start(cmd, label);

    let mut child = cmd
        .stdin(Stdio::inherit())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit())
        .spawn()
        .with_context(|| format!("启动命令失败: {}", label))?;
    let started = Instant::now();

    loop {
        if let Some(status) = child.try_wait()? {
            if !status.success() {
                log_line(format!("命令失败: {}, 退出码: {:?}", label, status.code()));
                bail!("命令执行失败: {}, 退出码: {:?}", label, status.code());
            }

            log_line(format!("命令完成: {}, 退出码: {:?}", label, status.code()));
            return Ok(());
        }

        if started.elapsed() >= timeout {
            let termination_detail = terminate_child_bounded(
                &mut child,
                PROCESS_TERMINATION_GRACE,
                PROCESS_POLL_INTERVAL,
            );
            let message = format!(
                "命令超时: {}, 超时: {} 秒{}",
                label,
                timeout.as_secs(),
                termination_detail
                    .as_deref()
                    .map(|detail| format!("; {detail}"))
                    .unwrap_or_default()
            );
            log_line(&message);
            bail!(message);
        }

        let remaining = timeout.saturating_sub(started.elapsed());
        thread::sleep(PROCESS_POLL_INTERVAL.min(remaining));
    }
}

pub(crate) fn run_command_capture(cmd: &mut Command, label: &str) -> Result<String> {
    let output = run_command_output(cmd, label)?;
    let (stdout, stderr) = output_to_strings(&output);

    print_and_log_output(&stdout, &stderr);

    if !output.status.success() {
        log_line(format!(
            "命令失败: {}, 退出码: {:?}",
            label,
            output.status.code()
        ));
        bail!(
            "命令执行失败: {}, 退出码: {:?}",
            label,
            output.status.code()
        );
    }

    log_line(format!(
        "命令完成: {}, 退出码: {:?}",
        label,
        output.status.code()
    ));

    Ok(format!("{}\n\n{}", stdout, stderr))
}

pub(crate) fn run_command_capture_timeout(
    cmd: &mut Command,
    label: &str,
    timeout: Duration,
) -> Result<String> {
    let output = run_command_output_timeout(cmd, label, timeout)?;
    let (stdout, stderr) = output_to_strings(&output);

    print_and_log_output(&stdout, &stderr);

    if !output.status.success() {
        log_line(format!(
            "命令失败: {}, 退出码: {:?}",
            label,
            output.status.code()
        ));
        bail!(
            "命令执行失败: {}, 退出码: {:?}",
            label,
            output.status.code()
        );
    }

    log_line(format!(
        "命令完成: {}, 退出码: {:?}",
        label,
        output.status.code()
    ));

    Ok(format!("{}\n\n{}", stdout, stderr))
}

pub(crate) fn run_command_output_status(cmd: &mut Command, label: &str) -> Result<ExitStatus> {
    let output = run_command_output(cmd, label)?;
    let (stdout, stderr) = output_to_strings(&output);

    print_and_log_output(&stdout, &stderr);
    log_line(format!(
        "命令结束: {}, 退出码: {:?}",
        label,
        output.status.code()
    ));

    Ok(output.status)
}

fn run_command_output(cmd: &mut Command, label: &str) -> Result<Output> {
    log_command_start(cmd, label);
    cmd.stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .with_context(|| format!("启动命令失败: {}", label))
}

pub(crate) fn run_command_output_timeout(
    cmd: &mut Command,
    label: &str,
    timeout: Duration,
) -> Result<Output> {
    run_command_output_timeout_with_limits(
        cmd,
        label,
        timeout,
        PROCESS_TERMINATION_GRACE,
        PROCESS_POLL_INTERVAL,
        true,
    )
}

pub(crate) fn run_command_output_timeout_quiet(
    cmd: &mut Command,
    label: &str,
    timeout: Duration,
) -> Result<Output> {
    run_command_output_timeout_with_limits(
        cmd,
        label,
        timeout,
        PROCESS_TERMINATION_GRACE,
        PROCESS_POLL_INTERVAL,
        false,
    )
}

fn run_command_output_timeout_with_limits(
    cmd: &mut Command,
    label: &str,
    timeout: Duration,
    termination_grace: Duration,
    poll_interval: Duration,
    log_start: bool,
) -> Result<Output> {
    if log_start {
        log_command_start(cmd, label);
    }

    let mut child = cmd
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .with_context(|| format!("启动命令失败: {}", label))?;
    let stdout = CapturedPipe::spawn(child.stdout.take().context("获取命令标准输出管道失败")?);
    let stderr = CapturedPipe::spawn(child.stderr.take().context("获取命令标准错误管道失败")?);

    let started = Instant::now();
    loop {
        if let Some(status) = child.try_wait()? {
            let remaining = timeout.saturating_sub(started.elapsed());
            let output_ready = poll_until(remaining, poll_interval, || {
                Ok((stdout.is_finished() && stderr.is_finished()).then_some(()))
            })?
            .is_some();
            if !output_ready {
                print_and_log_captured_output(&stdout, &stderr);
                let message = format!("命令超时: {label}; 进程已退出，但读取输出超时");
                log_line(&message);
                bail!(message);
            }
            return Ok(Output {
                status,
                stdout: stdout
                    .finish()
                    .with_context(|| format!("读取命令标准输出失败: {label}"))?,
                stderr: stderr
                    .finish()
                    .with_context(|| format!("读取命令标准错误失败: {label}"))?,
            });
        }

        if started.elapsed() >= timeout {
            let termination_detail =
                terminate_child_bounded(&mut child, termination_grace, poll_interval);
            print_and_log_captured_output(&stdout, &stderr);
            let message = format!(
                "命令超时: {}, 超时: {} 秒{}",
                label,
                timeout.as_secs(),
                termination_detail
                    .as_deref()
                    .map(|detail| format!("; {detail}"))
                    .unwrap_or_default()
            );
            log_line(&message);
            bail!(message);
        }

        let remaining = timeout.saturating_sub(started.elapsed());
        thread::sleep(poll_interval.min(remaining));
    }
}

fn print_and_log_captured_output(stdout: &CapturedPipe, stderr: &CapturedPipe) {
    let stdout = String::from_utf8_lossy(&stdout.snapshot()).into_owned();
    let stderr = String::from_utf8_lossy(&stderr.snapshot()).into_owned();
    print_and_log_output(&stdout, &stderr);
}

fn terminate_child_bounded(
    child: &mut std::process::Child,
    grace: Duration,
    poll_interval: Duration,
) -> Option<String> {
    let kill_error = child.kill().err();
    match poll_until(grace, poll_interval, || child.try_wait()) {
        Ok(Some(_)) => None,
        Ok(None) => Some(match kill_error {
            Some(error) => format!("终止失败: {error}; 等待终止超时"),
            None => "已发送终止请求，但等待终止超时".to_string(),
        }),
        Err(error) => Some(match kill_error {
            Some(kill_error) => format!("终止失败: {kill_error}; 检查终止状态失败: {error}"),
            None => format!("检查终止状态失败: {error}"),
        }),
    }
}

fn poll_until<T>(
    timeout: Duration,
    poll_interval: Duration,
    mut poll: impl FnMut() -> io::Result<Option<T>>,
) -> io::Result<Option<T>> {
    let started = Instant::now();
    loop {
        if let Some(value) = poll()? {
            return Ok(Some(value));
        }

        let remaining = timeout.saturating_sub(started.elapsed());
        if remaining.is_zero() {
            return Ok(None);
        }
        thread::sleep(poll_interval.min(remaining));
    }
}

fn log_command_start(cmd: &Command, label: &str) {
    println!("\n>>> {}", label);
    println!("{:?}", cmd);
    log_line(format!(">>> {}", label));
    log_line(format!("{:?}", cmd));
}

fn output_to_strings(output: &Output) -> (String, String) {
    (
        String::from_utf8_lossy(&output.stdout).to_string(),
        String::from_utf8_lossy(&output.stderr).to_string(),
    )
}

fn print_and_log_output(stdout: &str, stderr: &str) {
    if !stdout.is_empty() {
        print!("{}", stdout);
        log_text("stdout", stdout);
    }
    if !stderr.is_empty() {
        eprint!("{}", stderr);
        log_text("stderr", stderr);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::env;

    const CHILD_MODE_ENV: &str = "VIDEOAUTO_PROCESS_TEST_CHILD_MODE";

    fn test_child_command(mode: &str) -> Command {
        let mut command =
            Command::new(env::current_exe().expect("resolve current test executable"));
        command
            .arg("--exact")
            .arg("process::tests::child_fixture")
            .arg("--nocapture")
            .env(CHILD_MODE_ENV, mode);
        command
    }

    #[test]
    fn child_fixture() {
        match env::var(CHILD_MODE_ENV).as_deref() {
            Ok("sleep") => thread::sleep(Duration::from_secs(30)),
            Ok("descendant") => {
                let mut descendant = test_child_command("descendant-sleep")
                    .spawn()
                    .expect("spawn pipe-holding descendant");
                thread::spawn(move || {
                    let _ = descendant.wait();
                });
                println!("process-test-descendant-started");
                thread::sleep(Duration::from_secs(30));
            }
            Ok("descendant-sleep") => thread::sleep(Duration::from_secs(3)),
            Ok("output") => {
                println!("process-test-stdout");
                eprintln!("process-test-stderr");
            }
            _ => {}
        }
    }

    #[test]
    fn timeout_does_not_wait_for_pipes_held_by_a_descendant() {
        let started = Instant::now();
        let error = run_command_output_timeout_with_limits(
            &mut test_child_command("descendant"),
            "timeout test child",
            Duration::from_millis(300),
            Duration::from_millis(250),
            Duration::from_millis(5),
            true,
        )
        .expect_err("sleeping child must time out");

        assert!(error.to_string().contains("命令超时"));
        assert!(
            started.elapsed() < Duration::from_secs(2),
            "timeout path exceeded its bounded grace period: {:?}",
            started.elapsed()
        );
    }

    #[test]
    fn inherited_output_command_honors_timeout() {
        let started = Instant::now();
        let error = run_command_timeout(
            &mut test_child_command("sleep"),
            "inherited output timeout test",
            Duration::from_millis(300),
        )
        .expect_err("sleeping child must time out");

        assert!(error.to_string().contains("命令超时"));
        assert!(
            started.elapsed() < Duration::from_secs(2),
            "timeout path exceeded its bounded grace period: {:?}",
            started.elapsed()
        );
    }

    #[test]
    fn termination_polling_returns_when_nothing_ever_exits() {
        let started = Instant::now();
        let result = poll_until(Duration::from_millis(25), Duration::from_millis(2), || {
            Ok::<_, io::Error>(None::<()>)
        })
        .expect("polling should not fail");

        assert!(result.is_none());
        assert!(started.elapsed() < Duration::from_millis(500));
    }

    #[test]
    fn completed_command_keeps_captured_stdout_and_stderr() {
        let output = run_command_output_timeout_with_limits(
            &mut test_child_command("output"),
            "output test child",
            Duration::from_secs(5),
            Duration::from_millis(250),
            Duration::from_millis(5),
            true,
        )
        .expect("output child should complete");

        let (stdout, stderr) = output_to_strings(&output);
        assert!(output.status.success());
        assert!(stdout.contains("process-test-stdout"));
        assert!(stderr.contains("process-test-stderr"));
    }
}
