#!/usr/bin/env bash
# Ctrl+C(SIGINT)가 electron-vite dev 프로세스만 죽이고, 이미 spawn된 Electron 본체
# (+GPU/네트워크/렌더러 헬퍼)는 못 죽이는 경우가 있다 — macOS에서 Electron이 launchd에
# 재부모화(PPID=1)돼 있으면 터미널의 SIGINT가 애초에 그 프로세스 그룹에 전달되지 않는다
# (실측 확인: dev 서버 종료 후에도 Electron 메인 프로세스의 PPID가 1로 남아있었음).
# app.requestSingleInstanceLock()(main/index.ts) 때문에 이렇게 남은 좀비 인스턴스가
# 있으면 다음 `npm run dev`가 락을 못 얻고 조용히 바로 종료돼버려("아무 창도 안 뜸"으로
# 보임) — predev에서 항상 먼저 정리한다. 프로젝트 경로로 뜬 Electron만 매칭해서
# VSCode/Claude Desktop 등 무관한 다른 Electron 앱은 건드리지 않는다.
set -euo pipefail
cd "$(dirname "$0")/.."
PROJECT_DIR="$(pwd)"

pids=$(pgrep -f "${PROJECT_DIR}/node_modules/electron" || true)
if [ -n "$pids" ]; then
  echo "이전 Nuance Electron 프로세스 정리: $pids"
  kill -9 $pids 2>/dev/null || true
else
  echo "정리할 Nuance 프로세스 없음"
fi
