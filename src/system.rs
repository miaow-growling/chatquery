//! System resource monitoring and cache management.

/// 获取当前进程实际占用的物理常驻内存（Resident Set Size, RSS），单位为字节。
/// 跨平台支持 macOS (Mach Task Info), Windows (K32/PSAPI), Linux (/proc/self/statm)。
pub fn get_process_memory_bytes() -> u64 {
    #[cfg(target_os = "macos")]
    {
        extern "C" {
            fn mach_task_self() -> u32;
            fn task_info(
                target_task: u32,
                flavor: u32,
                task_info_out: *mut i32,
                task_info_outCnt: *mut u32,
            ) -> i32;
        }

        #[repr(C)]
        struct MachTaskBasicInfo {
            virtual_size: u64,
            resident_size: u64,
            resident_size_max: u64,
            user_time: [i32; 2],
            system_time: [i32; 2],
            policy: i32,
            suspend_count: i32,
        }

        const MACH_TASK_BASIC_INFO: u32 = 20;
        const MACH_TASK_BASIC_INFO_COUNT: u32 =
            (std::mem::size_of::<MachTaskBasicInfo>() / std::mem::size_of::<u32>()) as u32;

        unsafe {
            let mut info: MachTaskBasicInfo = std::mem::zeroed();
            let mut count = MACH_TASK_BASIC_INFO_COUNT;
            let kerr = task_info(
                mach_task_self(),
                MACH_TASK_BASIC_INFO,
                &mut info as *mut _ as *mut i32,
                &mut count,
            );
            if kerr == 0 {
                return info.resident_size;
            }
        }
    }

    #[cfg(target_os = "windows")]
    {
        #[repr(C)]
        struct ProcessMemoryCounters {
            cb: u32,
            page_fault_count: u32,
            peak_working_set_size: usize,
            working_set_size: usize,
            quota_peak_paged_pool_usage: usize,
            quota_paged_pool_usage: usize,
            quota_peak_non_paged_pool_usage: usize,
            quota_non_paged_pool_usage: usize,
            pagefile_usage: usize,
            peak_pagefile_usage: usize,
        }

        #[link(name = "psapi")]
        extern "system" {
            fn GetCurrentProcess() -> *mut std::ffi::c_void;
            fn GetProcessMemoryInfo(
                process: *mut std::ffi::c_void,
                counters: *mut ProcessMemoryCounters,
                cb: u32,
            ) -> i32;
        }

        unsafe {
            let mut counters: ProcessMemoryCounters = std::mem::zeroed();
            counters.cb = std::mem::size_of::<ProcessMemoryCounters>() as u32;
            let process = GetCurrentProcess();
            if GetProcessMemoryInfo(process, &mut counters, counters.cb) != 0 {
                return counters.working_set_size as u64;
            }
        }
    }

    #[cfg(target_os = "linux")]
    {
        if let Ok(content) = std::fs::read_to_string("/proc/self/statm") {
            if let Some(pages) = content.split_whitespace().nth(1).and_then(|s| s.parse::<u64>().ok()) {
                return pages * 4096;
            }
        }
    }

    0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_memory_is_positive() {
        let mem = get_process_memory_bytes();
        println!("Process memory: {} bytes ({} MB)", mem, (mem as f64) / 1024.0 / 1024.0);
        assert!(mem > 0);
    }
}
