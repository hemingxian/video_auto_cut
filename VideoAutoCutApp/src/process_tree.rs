//! Isolate only explicitly managed streaming commands, leaving other launchers unchanged.
use std::io;
use std::process::{Child, Command};

#[cfg(windows)]
mod platform {
    use super::*;
    use std::mem::size_of;
    use std::os::windows::io::AsRawHandle;
    use std::os::windows::process::CommandExt;
    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, TH32CS_SNAPTHREAD, THREADENTRY32, Thread32First, Thread32Next,
    };
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JobObjectExtendedLimitInformation,
        SetInformationJobObject, TerminateJobObject,
    };
    use windows_sys::Win32::System::Threading::{
        CREATE_NO_WINDOW, CREATE_SUSPENDED, OpenThread, ResumeThread, THREAD_SUSPEND_RESUME,
    };

    pub(super) struct Tree(HANDLE);
    impl Tree {
        pub(super) fn spawn(command: &mut Command) -> io::Result<(Child, Self)> {
            // Suspend at creation, then attach the job before any child code can spawn workers.
            // This closes the race inherent in assigning a job after a normal spawn.
            let handle = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
            if handle.is_null() {
                return Err(io::Error::last_os_error());
            }
            let tree = Self(handle);
            let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { std::mem::zeroed() };
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            if unsafe {
                SetInformationJobObject(
                    handle,
                    JobObjectExtendedLimitInformation,
                    &limits as *const _ as _,
                    size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
                )
            } == 0
            {
                return Err(io::Error::last_os_error());
            }
            let mut child = command
                .creation_flags(CREATE_SUSPENDED | CREATE_NO_WINDOW)
                .spawn()?;
            let assigned = unsafe { AssignProcessToJobObject(handle, child.as_raw_handle()) } != 0;
            let resume = if assigned {
                resume_initial_thread(child.id())
            } else {
                Err(io::Error::last_os_error())
            };
            if let Err(error) = resume {
                let _ = child.kill();
                // Send termination and check once; avoid any unbounded wait on a launch failure.
                let _ = child.try_wait();
                return Err(error);
            }
            Ok((child, tree))
        }

        pub(super) fn terminate(&self) -> io::Result<()> {
            if unsafe { TerminateJobObject(self.0, 1) } == 0 {
                Err(io::Error::last_os_error())
            } else {
                Ok(())
            }
        }
    }

    fn resume_initial_thread(pid: u32) -> io::Result<()> {
        let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0) };
        if snapshot == INVALID_HANDLE_VALUE {
            return Err(io::Error::last_os_error());
        }
        let mut entry: THREADENTRY32 = unsafe { std::mem::zeroed() };
        entry.dwSize = size_of::<THREADENTRY32>() as u32;
        let mut found = false;
        let mut error = None;
        let mut has_entry = unsafe { Thread32First(snapshot, &mut entry) } != 0;
        while has_entry {
            if entry.th32OwnerProcessID == pid {
                let thread = unsafe { OpenThread(THREAD_SUSPEND_RESUME, 0, entry.th32ThreadID) };
                if thread.is_null() {
                    error = Some(io::Error::last_os_error());
                    break;
                }
                let resumed = unsafe { ResumeThread(thread) };
                if resumed == u32::MAX {
                    error = Some(io::Error::last_os_error());
                }
                unsafe {
                    CloseHandle(thread);
                }
                found = true;
                break;
            }
            has_entry = unsafe { Thread32Next(snapshot, &mut entry) } != 0;
        }
        unsafe {
            CloseHandle(snapshot);
        }
        if let Some(error) = error {
            return Err(error);
        }
        if !found {
            return Err(io::Error::other("未找到索引子进程的初始线程"));
        }
        Ok(())
    }

    impl Drop for Tree {
        fn drop(&mut self) {
            unsafe {
                CloseHandle(self.0);
            }
        }
    }
}

#[cfg(unix)]
mod platform {
    use super::*;
    use std::os::unix::process::CommandExt;
    pub(super) struct Tree(u32);
    impl Tree {
        pub(super) fn spawn(command: &mut Command) -> io::Result<(Child, Self)> {
            let child = command.process_group(0).spawn()?;
            let tree = Self(child.id());
            Ok((child, tree))
        }
        pub(super) fn terminate(&self) -> io::Result<()> {
            if unsafe { libc::kill(-(self.0 as i32), libc::SIGKILL) } == 0 {
                return Ok(());
            }
            let error = io::Error::last_os_error();
            if error.raw_os_error() == Some(libc::ESRCH) {
                Ok(())
            } else {
                Err(error)
            }
        }
    }
    impl Drop for Tree {
        fn drop(&mut self) {
            let _ = self.terminate();
        }
    }
}

pub(super) struct ProcessTree(platform::Tree);
impl ProcessTree {
    pub(super) fn spawn(command: &mut Command) -> io::Result<(Child, Self)> {
        let (child, tree) = platform::Tree::spawn(command)?;
        Ok((child, Self(tree)))
    }
    pub(super) fn terminate(&self) -> io::Result<()> {
        self.0.terminate()
    }
}

pub(super) fn cancel_reader<T>(thread: &std::thread::JoinHandle<T>) {
    #[cfg(windows)]
    {
        use std::os::windows::io::AsRawHandle;
        unsafe {
            windows_sys::Win32::System::IO::CancelSynchronousIo(thread.as_raw_handle());
        }
    }
    #[cfg(not(windows))]
    let _ = thread;
}
