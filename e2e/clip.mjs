#!/usr/bin/env node
// soksak-plugin-clip E2E — 클립보드 캡처/dedup/검색/즐겨찾기 + 메모(영구) + 카테고리 + 보존 purge.
// 소켓(JSON-RPC)으로 실제 앱을 구동한다. 자동 캡처(watch)는 코어가 self-write echo 를 억제하므로
// 헤드리스에선 clip.capture(같은 단일 유틸)로 검증한다. 멱등 — 시작·끝에 clear.
//
// 사용: SOKSAK_SOCKET=~/.soksak/com.soksak.dev.sock node e2e/clip.mjs   (이 repo 루트)
// 종료코드: 0 = PASS, 1 = FAIL.

import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const SOCKET = process.env.SOKSAK_SOCKET || path.join(os.homedir(), ".soksak", "com.soksak.dev.sock");
const PLUGIN = "soksak-plugin-clip";
const PLUGIN_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

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
async function waitReady(t = 60) {
  for (let i = 0; i < t; i++) {
    try {
      if ((await rpc("state.context", {})).ok) return true;
    } catch {}
    await sleep(500);
  }
  return false;
}

let passed = 0;
const failures = [];
const ok = (c, l) => (c ? (passed++, console.log(`  ✓ ${l}`)) : (failures.push(l), console.log(`  ✗ ${l}`)));
const section = (n) => console.log(`\n[${n}]`);

async function main() {
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
  if (!(await waitReady())) {
    console.error("앱 미준비");
    process.exit(1);
  }
  console.log(`소켓: ${SOCKET}`);

  section("setup");
  await rpc("plugin.disable", { id: PLUGIN }).catch(() => {});
  ok((await rpc("plugin.dev.load", { path: PLUGIN_DIR })).ok !== false, "plugin.dev.load(최신 main.js)");
  ok((await rpc("plugin.enable", { id: PLUGIN })).ok !== false, "plugin.enable");
  await m("clip.clear", {}); // 전체 비우기(멱등 시작)

  // ── 클립보드 캡처/dedup/검색 ──
  section("클립보드 — 캡처·dedup·검색");
  const cap = await m("clip.capture", { text: "비밀번호123" });
  ok(cap.ok && typeof cap.itemId === "string", "clip.capture → itemId");
  const cap2 = await m("clip.capture", { text: "비밀번호123" });
  ok(cap2.ok && cap2.deduped === true && cap2.itemId === cap.itemId, "같은 내용 → dedup(copyCount++)");
  await m("clip.capture", { text: "안녕하세요 클립" });
  const sr = await m("clip.search", { query: "클립" });
  ok(sr.ok && sr.items.some((c) => c.content.includes("클립")), "CJK 검색 적중");
  const st1 = await m("clip.state", {});
  ok(st1.clips === 2 && st1.memos === 0, `상태: 클립보드 2·메모 0(got ${st1.clips}/${st1.memos})`);
  ok(st1.retentionDays >= 1 && st1.retentionDays <= 30, `보존일 설정(${st1.retentionDays})`);

  // ── 메모(영구) ──
  section("메모 — 작성·영구");
  const memo = await m("memo.add", { content: "영구 메모입니다" });
  ok(memo.ok && typeof memo.itemId === "string", "memo.add → itemId");
  const memos = await m("clip.list", { kind: "memo" });
  ok(memos.items.length === 1 && memos.items[0].kind === "memo", "메모 목록 1건(kind=memo)");

  // ── 카테고리 ──
  section("카테고리 — 기본·추가·이동·이름변경·삭제");
  const cats0 = await m("category.list", {});
  ok(cats0.categories.includes("기본"), "기본 카테고리 존재");
  ok((await m("category.add", { name: "업무" })).ok, "category.add(업무)");
  ok((await m("clip.category", { id: memo.itemId, category: "업무" })).category === "업무", "메모를 업무로 이동");
  const inBiz = await m("clip.list", { category: "업무" });
  ok(inBiz.items.some((c) => c.id === memo.itemId), "업무 카테고리에 메모");
  const ren = await m("category.rename", { from: "업무", to: "회사" });
  ok(ren.ok && ren.moved === 1, "category.rename(업무→회사) 항목 동반 이동");
  ok((await m("clip.list", { category: "회사" })).items.some((c) => c.id === memo.itemId), "회사 카테고리로 옮겨짐");
  const del = await m("category.delete", { name: "회사" });
  ok(del.ok && del.moved === 1, "category.delete(회사) — 항목은 기본으로");
  ok((await m("clip.list", { category: "기본" })).items.some((c) => c.id === memo.itemId), "메모가 기본으로 복귀");
  ok((await m("category.delete", { name: "기본" })).ok === false, "기본 카테고리 삭제 거부");

  // ── 보존 purge(즐겨찾기·메모 예외) ──
  section("보존 — purge(즐겨찾기·메모 예외)");
  const keep = await m("clip.capture", { text: "즐겨찾기 클립" });
  await m("clip.favorite", { id: keep.itemId }); // 즐겨찾기 → 보존 예외
  const before = (await m("clip.state", {})).clips;
  ok(before >= 2, `purge 전 클립보드 ${before}건`);
  const purge = await m("clip.purge", { olderThanMs: 0 }); // 0ms 보다 오래 = 전부(즐겨찾기 제외)
  ok(purge.ok && purge.purged >= 1, `purge → ${purge.purged}건 삭제`);
  const after = await m("clip.state", {});
  ok(after.clips === 1, `purge 후 클립보드 1건(즐겨찾기만 남음, got ${after.clips})`);
  ok(after.memos === 1, "메모는 보존(영구)");
  ok((await m("clip.list", { favorite: true })).items.some((c) => c.id === keep.itemId), "즐겨찾기 클립 잔존");

  // ── 휴지통 ──
  section("휴지통 — 삭제·복원");
  await m("clip.delete", { id: keep.itemId });
  ok((await m("clip.count", { trash: true })).count >= 1, "휴지통으로 이동");
  await m("clip.restore", { id: keep.itemId });
  ok((await m("clip.list", { favorite: true })).items.some((c) => c.id === keep.itemId), "복원됨");

  // ── teardown ──
  section("teardown");
  ok((await m("clip.clear", {})).ok, "clip.clear(전체 정리)");
  ok((await m("clip.state", {})).clips === 0, "클립보드 0");

  console.log(`\n${"=".repeat(40)}`);
  if (!failures.length) {
    console.log(`PASS — ${passed}개 단언 전부 통과`);
    process.exit(0);
  }
  console.log(`FAIL — ${failures.length}개 실패:`);
  for (const f of failures) console.log(`  ✗ ${f}`);
  process.exit(1);
}

main().catch((e) => {
  console.error("E2E 예외:", e);
  process.exit(1);
});
