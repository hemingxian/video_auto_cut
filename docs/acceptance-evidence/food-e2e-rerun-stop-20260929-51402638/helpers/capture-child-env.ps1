param(
  [Parameter(Mandatory=$true)][string]$PidFile,
  [Parameter(Mandatory=$true)][string]$OutputFile,
  [Parameter(Mandatory=$false)][string]$ReadyFile
)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
public static class ProcEnv51402638 {
  [StructLayout(LayoutKind.Sequential)] public struct PBI { public IntPtr Reserved1, Peb, Reserved2, Reserved3; public IntPtr Pid, Reserved4; }
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] public struct PE { public uint Size, Usage; public uint Pid; public IntPtr DefaultHeap; public uint ModuleId, Threads, ParentPid; public int PriClassBase; public uint Flags; [MarshalAs(UnmanagedType.ByValTStr, SizeConst=260)] public string Exe; }
  [DllImport("ntdll.dll")] static extern int NtQueryInformationProcess(IntPtr h, int c, ref PBI p, int n, out int r);
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenProcess(uint a, bool i, int p);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool ReadProcessMemory(IntPtr h, IntPtr a, byte[] b, int n, out IntPtr r);
  [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)] static extern bool QueryFullProcessImageName(IntPtr h, int f, StringBuilder s, ref int n);
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr CreateToolhelp32Snapshot(uint f, uint p);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] static extern bool Process32First(IntPtr h, ref PE e);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] static extern bool Process32Next(IntPtr h, ref PE e);
  static IntPtr Ptr(IntPtr h, IntPtr a) { var b=new byte[IntPtr.Size]; IntPtr r; if(!ReadProcessMemory(h,a,b,b.Length,out r)||r.ToInt64()!=b.Length) throw new Win32Exception(); return IntPtr.Size==8?(IntPtr)BitConverter.ToInt64(b,0):(IntPtr)BitConverter.ToInt32(b,0); }
  public static Dictionary<string,string> Read(int pid) {
    IntPtr h=OpenProcess(0x0410,false,pid); if(h==IntPtr.Zero) throw new Win32Exception();
    try { var p=new PBI(); int ret; if(NtQueryInformationProcess(h,0,ref p,Marshal.SizeOf(p),out ret)!=0) throw new Exception("NtQueryInformationProcess");
      IntPtr pp=Ptr(h,IntPtr.Add(p.Peb,IntPtr.Size==8?0x20:0x10)); IntPtr ep=Ptr(h,IntPtr.Add(pp,IntPtr.Size==8?0x80:0x48));
      var bytes=new List<byte>(); for(int off=0;off<1048576;off+=4096){var b=new byte[4096];IntPtr got;if(!ReadProcessMemory(h,IntPtr.Add(ep,off),b,b.Length,out got)||got.ToInt64()==0)break;int n=(int)got;bytes.AddRange(new ArraySegment<byte>(b,0,n));for(int i=Math.Max(2,bytes.Count-n);i+3<bytes.Count;i+=2)if(bytes[i]==0&&bytes[i+1]==0&&bytes[i+2]==0&&bytes[i+3]==0){var text=Encoding.Unicode.GetString(bytes.ToArray(),0,i+2);var d=new Dictionary<string,string>(StringComparer.OrdinalIgnoreCase);foreach(var x in text.Split('\0')){int q=x.IndexOf('=');if(q>0)d[x.Substring(0,q)]=x.Substring(q+1);}return d;}}
      throw new Exception("environment terminator not found");
    } finally {CloseHandle(h);} }
  public static string Image(int pid){IntPtr h=OpenProcess(0x1000,false,pid);if(h==IntPtr.Zero)return null;try{var s=new StringBuilder(32768);int n=s.Capacity;return QueryFullProcessImageName(h,0,s,ref n)?s.ToString():null;}finally{CloseHandle(h);}}
  public static Dictionary<int,int> Parents(){var d=new Dictionary<int,int>();IntPtr h=CreateToolhelp32Snapshot(2,0);var e=new PE();e.Size=(uint)Marshal.SizeOf(e);try{if(Process32First(h,ref e))do{d[(int)e.Pid]=(int)e.ParentPid;e.Size=(uint)Marshal.SizeOf(e);}while(Process32Next(h,ref e));}finally{CloseHandle(h);}return d;}
}
'@
if($ReadyFile){[IO.File]::WriteAllText($ReadyFile,((@{ready_at=(Get-Date).ToUniversalTime().ToString('o');allowlisted_only=$true}|ConvertTo-Json)+"`n"),[Text.UTF8Encoding]::new($false))}
$deadline=(Get-Date).AddMinutes(5)
while(!(Test-Path -LiteralPath $PidFile)){if((Get-Date)-gt $deadline){throw 'engine pid file timeout'};Start-Sleep -Milliseconds 50}
$rootPid=[int](Get-Content -LiteralPath $PidFile -Raw)
$seen=@{}
$captureErrors=@()
$writeReceipt={param([bool]$Completed)
  $receipt=[ordered]@{schema='food-route-a-process-env/v1';root_pid=$rootPid;status=if($Completed){'complete'}else{'running'};records=@($seen.Values);capture_errors=@($captureErrors);only_allowlisted_environment_keys_recorded=$true;updated_at=(Get-Date).ToUniversalTime().ToString('o')}
  $tmp="$OutputFile.tmp";[IO.File]::WriteAllText($tmp,(($receipt|ConvertTo-Json -Depth 10)+"`n"),[Text.UTF8Encoding]::new($false));Move-Item -LiteralPath $tmp -Destination $OutputFile -Force
}
& $writeReceipt $false
$rootGoneAt=$null
while($true){
  $parents=[ProcEnv51402638]::Parents(); $targets=New-Object 'System.Collections.Generic.HashSet[int]'; [void]$targets.Add($rootPid)
  $changed=$true; while($changed){$changed=$false;foreach($kv in $parents.GetEnumerator()){if($targets.Contains($kv.Value)-and !$targets.Contains($kv.Key)){[void]$targets.Add($kv.Key);$changed=$true}}}
  foreach($pidNow in $targets){if($seen.ContainsKey($pidNow)){continue};try{$envMap=[ProcEnv51402638]::Read($pidNow);$seen[$pidNow]=[ordered]@{pid=$pidNow;parent_pid=if($parents.ContainsKey($pidNow)){$parents[$pidNow]}else{$null};image=[ProcEnv51402638]::Image($pidNow);captured_at=(Get-Date).ToUniversalTime().ToString('o');TEMP=$envMap['TEMP'];TMP=$envMap['TMP'];VIDEOAUTO_TEMP_DIR=$envMap['VIDEOAUTO_TEMP_DIR'];temp_exists=if($envMap['TEMP']){Test-Path -LiteralPath $envMap['TEMP']}else{$null};tmp_exists=if($envMap['TMP']){Test-Path -LiteralPath $envMap['TMP']}else{$null};videoauto_temp_exists=if($envMap['VIDEOAUTO_TEMP_DIR']){Test-Path -LiteralPath $envMap['VIDEOAUTO_TEMP_DIR']}else{$null}};& $writeReceipt $false}catch{$captureErrors+=@([ordered]@{pid=$pidNow;at=(Get-Date).ToUniversalTime().ToString('o');exception_type=$_.Exception.GetType().FullName});& $writeReceipt $false}}
  if(!$parents.ContainsKey($rootPid)){if($null-eq $rootGoneAt){$rootGoneAt=Get-Date};if(((Get-Date)-$rootGoneAt).TotalSeconds-ge 2){break}}
  Start-Sleep -Milliseconds 50
}
& $writeReceipt $true
