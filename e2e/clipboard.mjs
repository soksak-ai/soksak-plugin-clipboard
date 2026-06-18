#!/usr/bin/env node
// soksak-plugin-clipboard E2E — 멱등 시나리오 드라이버.
//
// 소켓(JSON-RPC)으로 실제 앱을 구동하고, 클립보드 커맨드 + 코어 clipboard.* 로 단언한다.
// 클립 이력은 전역(scope 없음) — clear 로 깨끗이 시작/정리해 격리한다(다른 테스트와 직렬).
//
// [캡처 구동 = clipboard.capture] 코어는 self-write echo 를 1회 억제한다(clipboard.rs should_emit) →
//   clipboard.write 로 쓴 값은 watch 로 되돌아오지 않는다(설계). 그래서 헤드리스에서 자동 캡처를
//   검증하려면 캡처 유틸을 그대로 타는 clipboard.capture 명령을 쓴다(watch 콜백과 단일 유틸 공유 —
//   같은 경로를 검증). 코어 clipboard.write/read 왕복은 별도로 한 번 확인한다.
//
// 전제: 코어 app(make dev)이 실행 중 + 이 플러그인이 dev-load 가능(이 repo 경로). dev 소스=동의 면제.
// 사용: SOKSAK_SOCKET=~/.soksak/com.soksak.dev.sock node e2e/clipboard.mjs   (이 플러그인 repo 루트에서)
// 종료코드: 0 = 전부 PASS, 1 = FAIL.

import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const SOCKET =
  process.env.SOKSAK_SOCKET || path.join(os.homedir(), ".soksak", "com.soksak.dev.sock");
const PLUGIN = "soksak-plugin-clipboard";
const PLUGIN_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// ── 소켓 RPC ──
let sock,
  seq = 0;
const pending = new Map();
let rbuf = "";
function connect() {
  return new Promise((resolve, reject) => {
    sock = net.createConnection(SOCKET);
    sock.setNoDelay(true);
    sock.once("connect", resolve);
    sock.once("error", reject);
    sock.on("data", (d) => {
      rbuf += d.toString("utf8");
      let i;
      while ((i = rbuf.indexOf("\n")) >= 0) {
        const line = rbuf.slice(0, i);
        rbuf = rbuf.slice(i + 1);
        if (!line.trim()) continue;
        const msg = JSON.parse(line);
        const p = pending.get(msg.id);
        if (p) {
          pending.delete(msg.id);
          p(msg);
        }
      }
    });
  });
}
function rpc(method, params = {}, opts = {}) {
  const id = ++seq;
  return new Promise((resolve, reject) => {
    pending.set(id, resolve);
    sock.write(JSON.stringify({ id, method, params, ...opts }) + "\n");
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error(`TIMEOUT ${method}`));
      }
    }, 15000);
  });
}
const m = (name, params, opts) => rpc(`plugin.${PLUGIN}.${name}`, params, opts);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 소켓 준비 폴링 — state.context ok 일 때까지(dev 빌드 대기).
async function waitSocketReady(tries = 60) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await rpc("state.context", {});
      if (r.ok) return true;
    } catch {
      /* 아직 미준비(소켓 미생성/부팅 중) */
    }
    await sleep(500);
  }
  return false;
}

// ── 단언 ──
let passed = 0;
const failures = [];
function ok(cond, label) {
  if (cond) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failures.push(label);
    console.log(`  ✗ ${label}`);
  }
}
function section(name) {
  console.log(`\n[${name}]`);
}

async function main() {
  // 소켓 생성 대기(dev 빌드 직후 폴링).
  for (let i = 0; i < 60; i++) {
    try {
      await connect();
      break;
    } catch {
      await sleep(500);
    }
  }
  if (!sock) {
    console.error("소켓 연결 실패:", SOCKET);
    process.exit(1);
  }
  const ready = await waitSocketReady();
  if (!ready) {
    console.error("앱 미준비(state.context) — dev 빌드 대기 초과");
    process.exit(1);
  }
  console.log(`소켓: ${SOCKET}`);

  // ── setup: 최신 main.js 재적재 + 활성(dev 소스=동의 면제) ──
  section("setup");
  await rpc("plugin.disable", { id: PLUGIN }).catch(() => {});
  const loaded = await rpc("plugin.dev.load", { path: PLUGIN_DIR });
  ok(loaded.ok, "plugin.dev.load(최신 main.js)");
  const enabled = await rpc("plugin.enable", { id: PLUGIN });
  ok(enabled.ok && enabled.status === "enabled", "plugin.enable(dev 동의 면제)");

  const count = async (trash) => (await m("clipboard.count", { trash })).count;

  // ── R1: clear → 빈 상태 ──
  section("R1 clear");
  ok((await m("clipboard.clear", {})).ok, "clipboard.clear");
  ok((await count(false)) === 0, "clear 후 비휴지통 count=0");

  // ── R2: 캡처 → count=1 ──
  section("R2 capture");
  const cap = await m("clipboard.capture", { text: "테스트" });
  ok(cap.ok && typeof cap.clipId === "string", "capture('테스트') → clipId");
  ok((await count(false)) === 1, "count=1");

  // ── R3: dedup — 같은 내용 재캡처 → count 그대로·copyCount 증가 ──
  section("R3 dedup");
  const cap2 = await m("clipboard.capture", { text: "테스트" });
  ok(cap2.ok && cap2.deduped === true && cap2.clipId === cap.clipId, "재캡처 → 같은 레코드(deduped)");
  ok((await count(false)) === 1, "count 그대로 1(dedup)");
  const list1 = await m("clipboard.list", {});
  const rec1 = list1.clips.find((c) => c.id === cap.clipId);
  ok(rec1 && rec1.copyCount === 2, "copyCount=2");

  // ── R4: 다른 내용 → count=2 ──
  section("R4 distinct");
  await m("clipboard.capture", { text: "테스트2" });
  ok((await count(false)) === 2, "count=2");

  // ── R5: CJK 전문검색 — '테스트' 가 둘 다 적중(부분일치) ──
  section("R5 CJK search");
  const s1 = await m("clipboard.search", { query: "테스트" });
  ok(s1.ok && s1.clips.length === 2, "search('테스트') → 2건(trigram 부분일치)");
  const s2 = await m("clipboard.search", { query: "테스트2" });
  ok(s2.clips.length === 1, "search('테스트2') → 1건");
  ok((await m("clipboard.search", { query: "없는내용zzz" })).clips.length === 0, "없는 검색어 → 0건");

  // ── R6: 즐겨찾기 토글 → favorite 목록 1 ──
  section("R6 favorite");
  const fav = await m("clipboard.favorite", { id: cap.clipId });
  ok(fav.ok && fav.favorite === true, "favorite 토글 → true");
  const favList = await m("clipboard.list", { favorite: true });
  ok(favList.clips.length === 1 && favList.clips[0].id === cap.clipId, "즐겨찾기 목록 1건");

  // ── R7: 소프트 삭제 → 비휴지통 count=1, 휴지통 count=1 ──
  section("R7 soft delete");
  ok((await m("clipboard.delete", { id: cap.clipId })).ok, "delete(소프트)");
  ok((await count(false)) === 1, "비휴지통 count=1");
  ok((await count(true)) === 1, "휴지통 count=1");
  ok((await m("clipboard.list", { favorite: true })).clips.length === 0, "삭제된 건 즐겨찾기 목록 제외");
  const trashList = await m("clipboard.list", { trash: true });
  ok(trashList.clips.length === 1 && trashList.clips[0].id === cap.clipId, "휴지통 목록에 등장");

  // ── R8: 복원 → 비휴지통 복귀 ──
  section("R8 restore");
  ok((await m("clipboard.restore", { id: cap.clipId })).ok, "restore");
  ok((await count(false)) === 2, "복원 후 비휴지통 count=2");
  ok((await count(true)) === 0, "휴지통 count=0");

  // ── R9: state introspection ──
  section("R9 state");
  const st = await m("clipboard.state", {});
  ok(st.ok && st.active === 2 && st.favorites === 1 && st.trash === 0, "state 요약(active/fav/trash)");

  // ── R10: 코어 clipboard.write/read 왕복(코어 seam 확인 — 자동캡처 echo 는 억제됨) ──
  section("R10 core clipboard round-trip");
  const W = "코어왕복-" + Date.now().toString(36);
  ok((await rpc("clipboard.write", { text: W })).ok, "코어 clipboard.write");
  await sleep(150);
  const rd = await rpc("clipboard.read", {});
  ok(rd.ok && rd.text === W, "코어 clipboard.read 가 같은 값(시스템 클립보드 왕복)");

  // ── R11: 빈/공백 캡처 무시 ──
  section("R11 blank ignored");
  const before = await count(false);
  const blank = await m("clipboard.capture", { text: "   " });
  ok(blank.ok === false, "공백만 캡처 → 거부");
  ok((await count(false)) === before, "count 불변");

  // ── teardown ──
  section("teardown");
  const cleared = await m("clipboard.clear", {});
  ok(cleared.ok, `clear → ${cleared.deleted}건 삭제`);
  ok((await count(false)) === 0 && (await count(true)) === 0, "전부 비움 확인");

  // ── 결과 ──
  console.log(`\n${"=".repeat(40)}`);
  if (failures.length === 0) {
    console.log(`PASS — ${passed}개 단언 전부 통과`);
    process.exit(0);
  } else {
    console.log(`FAIL — ${failures.length}개 실패:`);
    for (const f of failures) console.log(`  ✗ ${f}`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error("E2E 오류:", e);
  process.exit(1);
});
