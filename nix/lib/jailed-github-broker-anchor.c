#define _XOPEN_SOURCE 700

#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <ftw.h>
#include <signal.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

struct process_record {
  char state;
  pid_t parent;
  pid_t group;
  pid_t session;
  unsigned long long start_time;
};

static volatile sig_atomic_t shutdown_requested;

static void request_shutdown(int signal_number) {
  (void)signal_number;
  shutdown_requested = 1;
}

static bool parse_positive_long(const char *text, long *value) {
  char *end = NULL;
  errno = 0;
  long parsed = strtol(text, &end, 10);
  if (errno != 0 || end == text || *end != '\0' || parsed <= 0) {
    return false;
  }
  *value = parsed;
  return true;
}

static bool parse_start_time(const char *text, unsigned long long *value) {
  char *end = NULL;
  errno = 0;
  unsigned long long parsed = strtoull(text, &end, 10);
  if (errno != 0 || end == text || *end != '\0' || parsed == 0) {
    return false;
  }
  *value = parsed;
  return true;
}

static bool read_process_record(pid_t pid, struct process_record *record) {
  char path[64];
  char buffer[4096];
  snprintf(path, sizeof(path), "/proc/%ld/stat", (long)pid);
  FILE *file = fopen(path, "r");
  if (file == NULL) {
    return false;
  }
  bool read_ok = fgets(buffer, sizeof(buffer), file) != NULL;
  fclose(file);
  if (!read_ok) {
    return false;
  }

  char *fields = strrchr(buffer, ')');
  if (fields == NULL || fields[1] != ' ') {
    return false;
  }
  fields += 2;

  char *save = NULL;
  char *token = strtok_r(fields, " ", &save);
  for (int field = 1; field <= 20; ++field) {
    if (token == NULL) {
      return false;
    }
    char *end = NULL;
    errno = 0;
    if (field == 1) {
      record->state = token[0];
    } else if (field == 2) {
      record->parent = (pid_t)strtol(token, &end, 10);
    } else if (field == 3) {
      record->group = (pid_t)strtol(token, &end, 10);
    } else if (field == 4) {
      record->session = (pid_t)strtol(token, &end, 10);
    } else if (field == 20) {
      record->start_time = strtoull(token, &end, 10);
    }
    if (field == 2 || field == 3 || field == 4 || field == 20) {
      if (errno != 0 || end == token || (*end != '\0' && *end != '\n')) {
        return false;
      }
    }
    token = strtok_r(NULL, " ", &save);
  }
  return record->start_time != 0;
}

static bool process_matches(pid_t pid, unsigned long long start_time,
                            pid_t group, pid_t session) {
  struct process_record record = {0};
  return read_process_record(pid, &record) &&
         record.start_time == start_time && record.group == group &&
         record.session == session;
}

static bool group_has_live_process(pid_t group, pid_t session) {
  DIR *directory = opendir("/proc");
  if (directory == NULL) {
    return true;
  }
  bool found = false;
  struct dirent *entry;
  while ((entry = readdir(directory)) != NULL) {
    char *end = NULL;
    errno = 0;
    long candidate = strtol(entry->d_name, &end, 10);
    if (errno != 0 || end == entry->d_name || *end != '\0' || candidate <= 0) {
      continue;
    }
    struct process_record record = {0};
    if (read_process_record((pid_t)candidate, &record) &&
        record.group == group && record.session == session &&
        record.state != 'Z') {
      found = true;
      break;
    }
  }
  closedir(directory);
  return found;
}

static bool group_authority_is_live(pid_t supervisor_pid,
                                    unsigned long long supervisor_start,
                                    pid_t anchor_pid, pid_t child_pid,
                                    unsigned long long child_start) {
  struct process_record child = {0};
  return process_matches(supervisor_pid, supervisor_start, anchor_pid,
                         anchor_pid) &&
         read_process_record(child_pid, &child) &&
         child.start_time == child_start && child.parent == supervisor_pid &&
         child.group == child_pid && child.session == anchor_pid;
}

static void signal_owned_group(pid_t supervisor_pid,
                               unsigned long long supervisor_start,
                               pid_t anchor_pid,
                               pid_t child_pid,
                               unsigned long long child_start,
                               int signal_number) {
  if (group_authority_is_live(supervisor_pid, supervisor_start, anchor_pid,
                              child_pid, child_start)) {
    (void)kill(-child_pid, signal_number);
  }
}

static void wait_interval(void) {
  struct timespec interval = {.tv_sec = 0, .tv_nsec = 50000000};
  while (nanosleep(&interval, &interval) != 0 && errno == EINTR) {
  }
}

static bool write_all(int fd, const char *data, size_t length) {
  while (length > 0) {
    ssize_t written = write(fd, data, length);
    if (written < 0 && errno == EINTR) {
      continue;
    }
    if (written <= 0) {
      return false;
    }
    data += written;
    length -= (size_t)written;
  }
  return true;
}

static bool write_manager_identity(const char *path, pid_t manager_pid,
                                   unsigned long long manager_start) {
  char temporary[4096];
  char record[128];
  int temporary_length =
      snprintf(temporary, sizeof(temporary), "%s.tmp", path);
  int record_length = snprintf(record, sizeof(record), "%ld %llu\n",
                               (long)manager_pid, manager_start);
  if (temporary_length <= 0 || (size_t)temporary_length >= sizeof(temporary) ||
      record_length <= 0 || (size_t)record_length >= sizeof(record)) {
    return false;
  }
  int fd = open(temporary, O_WRONLY | O_CREAT | O_EXCL, 0600);
  if (fd < 0) {
    return false;
  }
  bool ok = write_all(fd, record, (size_t)record_length) && fsync(fd) == 0;
  if (close(fd) != 0) {
    ok = false;
  }
  if (ok) {
    ok = rename(temporary, path) == 0;
  }
  if (!ok) {
    (void)unlink(temporary);
  }
  return ok;
}

static int remove_entry(const char *path, const struct stat *status,
                        int type, struct FTW *walk) {
  (void)status;
  (void)type;
  (void)walk;
  return remove(path);
}

static void remove_runtime_directory(const char *path) {
  if (nftw(path, remove_entry, 32, FTW_DEPTH | FTW_PHYS) != 0 &&
      errno != ENOENT) {
    fprintf(stderr,
            "jailed GitHub broker: supervisor runtime cleanup failed\n");
  }
}

static bool stop_file_exists(const char *path) {
  return access(path, F_OK) == 0;
}

static bool child_has_exited(pid_t child_pid) {
  siginfo_t status = {0};
  if (waitid(P_PID, child_pid, &status, WEXITED | WNOHANG | WNOWAIT) != 0) {
    return errno == ECHILD;
  }
  return status.si_pid == child_pid;
}

static unsigned long long capture_child_identity(pid_t child_pid,
                                                  pid_t session) {
  for (int attempt = 0; attempt < 20; ++attempt) {
    struct process_record record = {0};
    if (read_process_record(child_pid, &record) &&
        record.group == child_pid && record.session == session &&
        record.start_time != 0) {
      return record.start_time;
    }
    wait_interval();
  }
  return 0;
}

static int reap_child(pid_t child_pid, int attempts) {
  int status = 0;
  for (int attempt = 0; attempt <= attempts; ++attempt) {
    pid_t result = waitpid(child_pid, &status, WNOHANG);
    if (result == child_pid) {
      if (WIFEXITED(status)) {
        return WEXITSTATUS(status);
      }
      return 1;
    }
    if (result < 0 && errno == ECHILD) {
      return 1;
    }
    wait_interval();
  }
  return 1;
}

static int supervise(pid_t child_pid, unsigned long long child_start,
                     unsigned long long supervisor_start, pid_t anchor_pid,
                     const char *stop_file, const char *runtime_directory,
                     int cleanup_attempts) {
  pid_t supervisor_pid = getpid();
  while (!shutdown_requested && !stop_file_exists(stop_file) &&
         !child_has_exited(child_pid)) {
    wait_interval();
  }

  signal_owned_group(supervisor_pid, supervisor_start, anchor_pid, child_pid,
                     child_start, SIGTERM);
  for (int attempt = 0; attempt < cleanup_attempts; ++attempt) {
    if (!group_has_live_process(child_pid, anchor_pid)) {
      break;
    }
    wait_interval();
  }
  if (group_has_live_process(child_pid, anchor_pid)) {
    signal_owned_group(supervisor_pid, supervisor_start, anchor_pid, child_pid,
                       child_start, SIGKILL);
  }
  for (int attempt = 0; attempt < cleanup_attempts; ++attempt) {
    if (!group_has_live_process(child_pid, anchor_pid)) {
      break;
    }
    wait_interval();
  }

  int child_status = reap_child(child_pid, cleanup_attempts);
  remove_runtime_directory(runtime_directory);
  return child_status;
}

static bool anchor_is_live(pid_t anchor_pid,
                           unsigned long long anchor_start) {
  struct process_record anchor = {0};
  return read_process_record(anchor_pid, &anchor) && anchor.state != 'Z' &&
         anchor.start_time == anchor_start && anchor.group == anchor_pid &&
         anchor.session == anchor_pid;
}

static int run_group_supervisor(pid_t anchor_pid,
                                unsigned long long anchor_start,
                                const char *stop_file,
                                const char *runtime_directory,
                                const char *manager_identity_file,
                                int cleanup_attempts, char **command) {
  if (prctl(PR_SET_PDEATHSIG, SIGUSR1) != 0 ||
      getppid() != anchor_pid || !anchor_is_live(anchor_pid, anchor_start) ||
      shutdown_requested || stop_file_exists(stop_file)) {
    remove_runtime_directory(runtime_directory);
    return 1;
  }

  struct process_record supervisor = {0};
  if (!read_process_record(getpid(), &supervisor) ||
      supervisor.state == 'Z' || supervisor.parent != anchor_pid ||
      supervisor.group != anchor_pid || supervisor.session != anchor_pid) {
    remove_runtime_directory(runtime_directory);
    return 1;
  }

  int manager_gate[2];
  if (pipe(manager_gate) != 0) {
    remove_runtime_directory(runtime_directory);
    return 1;
  }

  pid_t child_pid = fork();
  if (child_pid < 0) {
    (void)close(manager_gate[0]);
    (void)close(manager_gate[1]);
    remove_runtime_directory(runtime_directory);
    return 1;
  }
  if (child_pid == 0) {
    (void)close(manager_gate[1]);
    (void)signal(SIGUSR1, SIG_DFL);
    (void)signal(SIGHUP, SIG_DFL);
    (void)signal(SIGINT, SIG_DFL);
    (void)signal(SIGTERM, SIG_DFL);
    if (setpgid(0, 0) != 0) {
      _exit(1);
    }
    char start = 0;
    ssize_t gate_result;
    do {
      gate_result = read(manager_gate[0], &start, 1);
    } while (gate_result < 0 && errno == EINTR);
    (void)close(manager_gate[0]);
    if (gate_result != 1 || start != '1') {
      _exit(1);
    }
    execvp(command[0], command);
    _exit(127);
  }
  (void)close(manager_gate[0]);

  if (setpgid(child_pid, child_pid) != 0 && errno != EACCES) {
    (void)close(manager_gate[1]);
    (void)kill(child_pid, SIGKILL);
    (void)waitpid(child_pid, NULL, 0);
    remove_runtime_directory(runtime_directory);
    return 1;
  }
  unsigned long long child_start =
      capture_child_identity(child_pid, anchor_pid);
  if (child_start == 0 || shutdown_requested ||
      stop_file_exists(stop_file) ||
      !write_manager_identity(manager_identity_file, child_pid, child_start) ||
      shutdown_requested || !anchor_is_live(anchor_pid, anchor_start) ||
      !write_all(manager_gate[1], "1", 1)) {
    (void)close(manager_gate[1]);
    (void)kill(child_pid, SIGKILL);
    (void)waitpid(child_pid, NULL, 0);
    remove_runtime_directory(runtime_directory);
    return 1;
  }
  (void)close(manager_gate[1]);

  return supervise(child_pid, child_start, supervisor.start_time, anchor_pid,
                   stop_file, runtime_directory, cleanup_attempts);
}

static int wait_for_supervisor(pid_t supervisor_pid, int cleanup_attempts) {
  bool shutdown_forwarded = false;
  while (!child_has_exited(supervisor_pid)) {
    if (shutdown_requested && !shutdown_forwarded) {
      (void)kill(supervisor_pid, SIGTERM);
      shutdown_forwarded = true;
    }
    wait_interval();
  }
  return reap_child(supervisor_pid, cleanup_attempts);
}

int main(int argc, char **argv) {
  if (argc < 8) {
    return 2;
  }

  long expected_parent_long;
  long cleanup_attempts_long;
  unsigned long long expected_parent_start;
  if (!parse_positive_long(argv[1], &expected_parent_long) ||
      !parse_start_time(argv[2], &expected_parent_start) ||
      !parse_positive_long(argv[6], &cleanup_attempts_long) ||
      cleanup_attempts_long > 100000) {
    return 2;
  }

  struct sigaction action = {0};
  action.sa_handler = request_shutdown;
  sigemptyset(&action.sa_mask);
  if (sigaction(SIGUSR1, &action, NULL) != 0 ||
      sigaction(SIGHUP, &action, NULL) != 0 ||
      sigaction(SIGINT, &action, NULL) != 0 ||
      sigaction(SIGTERM, &action, NULL) != 0) {
    return 1;
  }
  if (setsid() < 0 || prctl(PR_SET_PDEATHSIG, SIGUSR1) != 0) {
    remove_runtime_directory(argv[4]);
    return 1;
  }

  struct process_record parent = {0};
  if (getppid() != (pid_t)expected_parent_long ||
      !read_process_record((pid_t)expected_parent_long, &parent) ||
      parent.state == 'Z' || parent.start_time != expected_parent_start) {
    remove_runtime_directory(argv[4]);
    return 1;
  }

  struct process_record anchor = {0};
  pid_t anchor_pid = getpid();
  if (!read_process_record(anchor_pid, &anchor) || anchor.state == 'Z' ||
      anchor.group != anchor_pid || anchor.session != anchor_pid) {
    remove_runtime_directory(argv[4]);
    return 1;
  }

  if (shutdown_requested || stop_file_exists(argv[3])) {
    remove_runtime_directory(argv[4]);
    return 1;
  }

  pid_t supervisor_pid = fork();
  if (supervisor_pid < 0) {
    remove_runtime_directory(argv[4]);
    return 1;
  }
  if (supervisor_pid == 0) {
    return run_group_supervisor(anchor_pid, anchor.start_time, argv[3], argv[4],
                                argv[5], (int)cleanup_attempts_long, &argv[7]);
  }
  return wait_for_supervisor(supervisor_pid, (int)cleanup_attempts_long);
}
