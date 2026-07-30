#!/usr/bin/env bash

# Process-ownership helpers for dev.sh. This file is sourced, not executed.

dev_meta_value() {
  local metadata_file="$1" wanted_key="$2" key value
  [ -r "$metadata_file" ] || return 1
  while IFS='=' read -r key value; do
    if [ "$key" = "$wanted_key" ]; then
      printf '%s\n' "$value"
      return 0
    fi
  done <"$metadata_file"
  return 1
}

dev_process_start_ticks() {
  local pid="$1" stat rest
  [[ "$pid" =~ ^[0-9]+$ ]] || return 1
  [ -r "/proc/$pid/stat" ] || return 1
  stat="$(<"/proc/$pid/stat")" || return 1
  rest="${stat##*) }"
  printf '%s\n' "$rest" | awk '{ print $20 }'
}

dev_process_group() {
  local pid="$1"
  ps -o pgid= -p "$pid" 2>/dev/null | tr -d '[:space:]'
}

dev_process_is_non_zombie() {
  local pid="$1" stat rest state
  [[ "$pid" =~ ^[0-9]+$ ]] || return 1
  [ -r "/proc/$pid/stat" ] || return 1
  stat="$(<"/proc/$pid/stat")" || return 1
  rest="${stat##*) }"
  state="${rest%% *}"
  [ "$state" != Z ]
}

dev_marker_matches() {
  local pid="$1" marker="$2"
  [[ "$pid" =~ ^[0-9]+$ ]] || return 1
  [ -r "/proc/$pid/environ" ] || return 1
  tr '\0' '\n' <"/proc/$pid/environ" 2>/dev/null \
    | grep -Fqx "WMS_DEV_SERVICE_MARKER=$marker"
}

dev_owned_group_member_pids() {
  local metadata_file="$1"
  local pid pgid marker candidate_pid candidate_pgid candidate_state
  pid="$(dev_meta_value "$metadata_file" pid 2>/dev/null)" || return 1
  pgid="$(dev_meta_value "$metadata_file" pgid 2>/dev/null)" || return 1
  marker="$(dev_meta_value "$metadata_file" marker 2>/dev/null)" || return 1
  [[ "$pid" =~ ^[0-9]+$ && "$pgid" =~ ^[0-9]+$ ]] || return 1
  [ "$pid" = "$pgid" ] && [ -n "$marker" ] || return 1

  while read -r candidate_pid candidate_pgid candidate_state; do
    [ "$candidate_pgid" = "$pgid" ] || continue
    [ "${candidate_state:0:1}" != Z ] || continue
    if dev_marker_matches "$candidate_pid" "$marker"; then
      printf '%s\n' "$candidate_pid"
    fi
  done < <(ps -eo pid=,pgid=,stat=)
}

dev_owned_group_has_members() {
  local metadata_file="$1" members
  members="$(dev_owned_group_member_pids "$metadata_file" 2>/dev/null)" || return 1
  [ -n "$members" ]
}

dev_owned_identity_matches() {
  local service="$1" metadata_file="$2"
  local recorded_service pid pgid start_ticks marker
  local actual_pgid actual_start_ticks

  recorded_service="$(dev_meta_value "$metadata_file" service 2>/dev/null)" || return 1
  pid="$(dev_meta_value "$metadata_file" pid 2>/dev/null)" || return 1
  pgid="$(dev_meta_value "$metadata_file" pgid 2>/dev/null)" || return 1
  start_ticks="$(dev_meta_value "$metadata_file" start_ticks 2>/dev/null)" || return 1
  marker="$(dev_meta_value "$metadata_file" marker 2>/dev/null)" || return 1

  [ "$recorded_service" = "$service" ] || return 1
  [[ "$pid" =~ ^[0-9]+$ && "$pgid" =~ ^[0-9]+$ && "$start_ticks" =~ ^[0-9]+$ ]] \
    || return 1
  [ "$pid" = "$pgid" ] || return 1
  [ -n "$marker" ] || return 1
  kill -0 "$pid" 2>/dev/null || return 1

  actual_pgid="$(dev_process_group "$pid")" || return 1
  actual_start_ticks="$(dev_process_start_ticks "$pid")" || return 1
  [ "$actual_pgid" = "$pgid" ] || return 1
  [ "$actual_start_ticks" = "$start_ticks" ] || return 1
  dev_marker_matches "$pid" "$marker"
}

dev_config_fingerprint_matches() {
  local metadata_file="$1" expected="$2" recorded
  recorded="$(dev_meta_value "$metadata_file" config_fingerprint 2>/dev/null)" \
    || return 1
  [ -n "$expected" ] && [ "$recorded" = "$expected" ]
}

dev_wait_for() {
  local timeout_seconds="$1" poll_seconds="$2"; shift 2
  local attempts attempt
  attempts="$(
    awk -v timeout="$timeout_seconds" -v poll="$poll_seconds" \
      'BEGIN {
        if (poll <= 0) poll = 0.1
        count = int(timeout / poll)
        if (count < 1) count = 1
        print count + 1
      }'
  )"
  for ((attempt = 0; attempt < attempts; attempt += 1)); do
    "$@" && return 0
    [ "$attempt" -ge "$((attempts - 1))" ] || sleep "$poll_seconds"
  done
  return 1
}

dev_start_owned_service() {
  local service="$1" display_name="$2" working_dir="$3"
  local metadata_file="$4" log_file="$5" config_fingerprint="$6"; shift 6
  local marker launcher_pid

  DEV_LAST_START_CREATED=0
  if dev_owned_identity_matches "$service" "$metadata_file"; then
    printf '  • %s already running (pid %s)\n' \
      "$display_name" "$(dev_meta_value "$metadata_file" pid)"
    return 0
  fi
  rm -f -- "$metadata_file"

  marker="wms-dev-${service}-$$-${RANDOM}-$(date +%s%N)"
  setsid bash -c '
    marker="$1"
    metadata_file="$2"
    service="$3"
    working_dir="$4"
    config_fingerprint="$5"
    shift 5

    export WMS_DEV_SERVICE_MARKER="$marker"
    export WMS_DEV_CONFIG_FINGERPRINT="$config_fingerprint"
    pid="$$"
    pgid="$(ps -o pgid= -p "$pid" 2>/dev/null | tr -d "[:space:]")"
    stat="$(cat "/proc/$pid/stat")"
    rest="${stat##*) }"
    read -r -a stat_fields <<<"$rest"
    start_ticks="${stat_fields[19]}"
    temporary="${metadata_file}.tmp.${pid}"
    umask 077
    {
      printf "pid=%s\n" "$pid"
      printf "pgid=%s\n" "$pgid"
      printf "start_ticks=%s\n" "$start_ticks"
      printf "marker=%s\n" "$marker"
      printf "service=%s\n" "$service"
      printf "config_fingerprint=%s\n" "$config_fingerprint"
    } >"$temporary"
    mv -f -- "$temporary" "$metadata_file"
    cd "$working_dir" || exit 1
    exec "$@"
  ' _ "$marker" "$metadata_file" "$service" "$working_dir" \
    "$config_fingerprint" "$@" \
    >>"$log_file" 2>&1 &
  launcher_pid=$!

  if ! dev_wait_for \
    "${WMS_DEV_READY_TIMEOUT_SECONDS:-30}" \
    "${WMS_DEV_POLL_INTERVAL_SECONDS:-0.1}" \
    dev_owned_identity_matches "$service" "$metadata_file"; then
    local actual_pgid recorded_marker recorded_service cleanup_failed=0
    recorded_marker="$(dev_meta_value "$metadata_file" marker 2>/dev/null)" \
      || recorded_marker=
    recorded_service="$(dev_meta_value "$metadata_file" service 2>/dev/null)" \
      || recorded_service=
    if [ "$recorded_marker" = "$marker" ] \
      && [ "$recorded_service" = "$service" ]; then
      dev_stop_owned_service \
        "$service" "$display_name" "$metadata_file" || cleanup_failed=1
    else
      actual_pgid="$(dev_process_group "$launcher_pid" 2>/dev/null)" \
        || actual_pgid=
      if [ "$actual_pgid" = "$launcher_pid" ] \
        && dev_marker_matches "$launcher_pid" "$marker"; then
        kill -TERM -- "-$actual_pgid" 2>/dev/null || true
        dev_wait_for \
          "${WMS_DEV_STOP_TIMEOUT_SECONDS:-8}" \
          "${WMS_DEV_POLL_INTERVAL_SECONDS:-0.1}" \
          dev_launcher_stopped "$launcher_pid" || true
        if kill -0 "$launcher_pid" 2>/dev/null; then
          kill -KILL -- "-$actual_pgid" 2>/dev/null || true
        fi
      fi
      rm -f -- "$metadata_file"
    fi
    if ! kill -0 "$launcher_pid" 2>/dev/null; then
      wait "$launcher_pid" 2>/dev/null || true
    fi
    printf '  ✗ %s failed to start; see %s\n' "$display_name" "$log_file" >&2
    [ "$cleanup_failed" -eq 0 ] || return 1
    return 1
  fi

  DEV_LAST_START_CREATED=1
  printf '  ✓ %s process started (pid %s)\n' \
    "$display_name" "$(dev_meta_value "$metadata_file" pid)"
}

dev_launcher_stopped() {
  local pid="$1"
  ! kill -0 "$pid" 2>/dev/null
}

dev_stop_owned_service() {
  local service="$1" display_name="$2" metadata_file="$3"
  local pid pgid

  if [ ! -e "$metadata_file" ]; then
    printf '  • %s is not owned by this script\n' "$display_name"
    return 0
  fi
  pid="$(dev_meta_value "$metadata_file" pid 2>/dev/null)" || pid=
  pgid="$(dev_meta_value "$metadata_file" pgid 2>/dev/null)" || pgid=
  if ! dev_owned_identity_matches "$service" "$metadata_file"; then
    # A live leader with a mismatched start tick/PGID/marker is PID reuse:
    # never fall back to signalling its group. Group fallback is only safe
    # after the recorded leader has exited or become a zombie.
    if dev_process_is_non_zombie "$pid" \
      || ! dev_owned_group_has_members "$metadata_file"; then
      rm -f -- "$metadata_file"
      printf '  • %s ownership metadata was stale; no process was signalled\n' \
        "$display_name"
      return 0
    fi
  fi

  kill -TERM -- "-$pgid" 2>/dev/null || true
  dev_wait_for \
    "${WMS_DEV_STOP_TIMEOUT_SECONDS:-8}" \
    "${WMS_DEV_POLL_INTERVAL_SECONDS:-0.1}" \
    dev_owned_group_stopped "$metadata_file" || true

  if dev_owned_group_has_members "$metadata_file"; then
    kill -KILL -- "-$pgid" 2>/dev/null || true
    dev_wait_for 1 "${WMS_DEV_POLL_INTERVAL_SECONDS:-0.1}" \
      dev_owned_group_stopped "$metadata_file" || true
  fi
  if dev_owned_group_has_members "$metadata_file"; then
    printf '  ✗ %s process group %s could not be stopped; ownership retained\n' \
      "$display_name" "$pgid" >&2
    return 1
  fi
  rm -f -- "$metadata_file"
  printf '  ✓ %s stopped (owned pid %s)\n' "$display_name" "$pid"
}

dev_owned_group_stopped() {
  local metadata_file="$1"
  ! dev_owned_group_has_members "$metadata_file"
}
