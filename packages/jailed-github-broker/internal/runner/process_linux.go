package runner

import (
	"os/exec"
	"syscall"
	"unsafe"
)

// processAuthority owns negative-PGID signalling while the group leader is an
// unreaped process. retireAndReap irrevocably retires that authority first.
type processAuthority struct {
	pgid       int
	kill       func(int, syscall.Signal) error
	reap       func() error
	terminated bool
	retired    bool
}

func newProcessAuthority(command *exec.Cmd) *processAuthority {
	return &processAuthority{
		pgid: command.Process.Pid,
		kill: syscall.Kill,
		reap: command.Wait,
	}
}

func (authority *processAuthority) terminate() {
	if authority.retired || authority.terminated {
		return
	}
	authority.terminated = true
	_ = authority.kill(-authority.pgid, syscall.SIGKILL)
}

func (authority *processAuthority) retireAndReap() error {
	// Even after ordinary leader completion, terminate remaining descendants
	// while the zombie leader still prevents numeric PID/PGID reuse.
	authority.terminate()
	authority.retired = true
	return authority.reap()
}

func waitWithoutReap(pid int) error {
	const processID = 1 // Linux P_PID
	var info [128]byte
	for {
		_, _, errno := syscall.Syscall6(
			syscall.SYS_WAITID,
			processID,
			uintptr(pid),
			uintptr(unsafe.Pointer(&info[0])),
			uintptr(syscall.WEXITED|syscall.WNOWAIT),
			0,
			0,
		)
		if errno == 0 {
			return nil
		}
		if errno != syscall.EINTR {
			return errno
		}
	}
}
