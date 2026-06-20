// 클립(Clip) 플러그인 — 내부에 두 종류: 클립보드(자동 캡처 이력) + 메모(사용자 작성, 영구).
// 데이터는 코어 app.data(SQLite, CJK 전문검색), 실시간은 app.data.watch(크로스윈도우, 폴링 0).
// 자동 캡처는 app.clipboard.watch(코어가 OS별 변경 이벤트를 단일 신호로 흡수).
//
// [항목 종류] 단일 컬렉션 items + kind:
//   - clip(클립보드): 자동 캡처(dedup·copyCount). 보존 = 즐겨찾기 아니면 retentionDays(기본 3·최대 30) 후 자동 삭제.
//   - memo(메모): 사용자 작성. 영구(보존 삭제 대상 아님).
// [카테고리] 모든 항목에 category(기본 "기본"). cats 컬렉션으로 add/rename/delete.
// [스코프] 전역(클립보드는 OS 단일 자원). [삭제] 소프트 삭제 boolean `deleted`(deletedAt 는 표시 메타).

const COLL = "items";
const CATS = "cats";
const DEFAULT_CAT = "기본";
const DAY_MS = 86_400_000;

export default {
  activate(ctx) {
    const app = ctx.app;
    const sub = (d) => ctx.subscriptions.push(d);
    const mounts = new Set();
    const err = (code, message) => ({ ok: false, code, message });
    const reg = (name, spec) => sub(app.commands.register(name, spec));

    // 설정 보존일(1~30, 기본 3). app.settings 없으면 기본.
    const retentionDays = () => {
      const v = app.settings && app.settings.get ? app.settings.get("retentionDays") : undefined;
      const n = typeof v === "number" ? v : 3;
      return Math.min(30, Math.max(1, Math.round(n)));
    };

    // ── 카테고리 ──────────────────────────────────────────────────────────────
    async function listCats() {
      const rows = await app.data.query(CATS, { order: "order", limit: 1000 });
      return rows.map((c) => String(c.name));
    }
    async function ensureDefaultCategory() {
      const rows = await app.data.query(CATS, { where: { name: DEFAULT_CAT }, limit: 1 });
      if (!rows.length) await app.data.put(CATS, { name: DEFAULT_CAT, order: 0 });
    }
    async function catExists(name) {
      const rows = await app.data.query(CATS, { where: { name }, limit: 1 });
      return rows.length > 0;
    }

    // ── 단일 캡처 유틸(R8) — watch 자동 캡처와 clip.capture 가 공유. clip 종류·기본 카테고리.
    async function captureText(raw) {
      const content = typeof raw === "string" ? raw.trim() : "";
      if (!content) return null;
      const candidates = await app.data.search(COLL, content, { limit: 50 });
      const existing = candidates.find(
        (c) => c.content === content && c.kind === "clip" && !c.deleted,
      );
      if (existing) {
        // 재복사 = 나이 갱신(at). 활성 클립은 보존, 방치만 purge.
        await app.data.put(
          COLL,
          { ...existing, copyCount: (existing.copyCount || 1) + 1, at: Date.now() },
          { id: existing.id },
        );
        return { itemId: existing.id, deduped: true };
      }
      const id = await app.data.put(COLL, {
        kind: "clip",
        content,
        category: DEFAULT_CAT,
        copyCount: 1,
        favorite: false,
        deleted: false,
        deletedAt: null,
        at: Date.now(),
      });
      // 신규 캡처 시점에 보존 지난 클립 정리(상시 작은 비용 — 윈도우 작음).
      void purgeOld().catch(() => {});
      return { itemId: id, deduped: false };
    }

    // ── 보존 정리 — clip(클립보드)이고 즐겨찾기 아니면 retentionDays 지난 것 하드 삭제. memo·즐겨찾기는 영구.
    //    나이 기준 = updated(마지막 복사). 재복사하면 갱신돼 활성 클립은 남고, 방치된 것만 사라진다.
    async function purgeOld() {
      const cutoff = Date.now() - retentionDays() * DAY_MS;
      const clips = await app.data.query(COLL, { where: { kind: "clip" }, limit: 100000 });
      const stale = clips.filter((c) => !c.favorite && typeof c.at === "number" && c.at < cutoff);
      for (const c of stale) await app.data.delete(COLL, c.id);
      return stale.length;
    }

    // ── 목록 질의(명령·뷰 공유) — kind/category/favorite/trash 필터, 최신순.
    async function listItems({ kind, category, favorite, trash, limit, offset }) {
      const where = { deleted: trash === true };
      if (kind) where.kind = kind;
      if (category) where.category = category;
      if (favorite) where.favorite = true;
      return app.data.query(COLL, { where, order: "at", desc: true, limit: limit ?? 300, offset });
    }

    // ── 자동 캡처 ──
    sub(app.clipboard.watch((e) => void captureText(e.text)));

    // ── 명령: clip.* (클립보드) ──────────────────────────────────────────────
    reg("clip.capture", {
      description: "Capture text as a clipboard item. Identical content increments copyCount instead of creating a duplicate; placed in the default category.",
      triggers: { ko: "클립보드 캡처 텍스트 저장" },
      params: { text: { type: "string", required: true } },
      returns: "{ itemId, deduped }",
      examples: ['sok plugin.soksak-plugin-clip.clip.capture \'{"text":"테스트"}\''],
      handler: async (p) => {
        if (typeof p.text !== "string") return err("INVALID_PARAMS", "text 필요");
        const r = await captureText(p.text);
        if (!r) return err("INVALID_PARAMS", "빈 텍스트는 캡처하지 않음");
        return { ok: true, ...r };
      },
    });

    reg("clip.list", {
      description: "List items in newest-first order. Filter by kind (clip|memo), category, favorite, or trash.",
      triggers: { ko: "클립보드 목록 항목 조회" },
      params: {
        kind: { type: "string", description: "clip | memo" },
        category: { type: "string" },
        favorite: { type: "boolean" },
        trash: { type: "boolean" },
        limit: { type: "number" },
        offset: { type: "number" },
      },
      returns: "{ items }",
      examples: ["sok plugin.soksak-plugin-clip.clip.list"],
      handler: async (p) => {
        const items = await listItems({
          kind: p.kind === "clip" || p.kind === "memo" ? p.kind : undefined,
          category: typeof p.category === "string" ? p.category : undefined,
          favorite: p.favorite === true,
          trash: p.trash === true,
          limit: typeof p.limit === "number" ? p.limit : 300,
          offset: typeof p.offset === "number" ? p.offset : undefined,
        });
        return { ok: true, items };
      },
    });

    reg("clip.search", {
      description: "Full-text CJK search across item content, excluding trash. Optionally narrow by kind (clip|memo).",
      triggers: { ko: "클립보드 검색 복사내용 찾기 전문검색" },
      params: { query: { type: "string", required: true }, kind: { type: "string" }, limit: { type: "number" } },
      returns: "{ items }",
      handler: async (p) => {
        if (typeof p.query !== "string") return err("INVALID_PARAMS", "query 필요");
        const hits = await app.data.search(COLL, p.query, { limit: typeof p.limit === "number" ? p.limit : 100 });
        const kind = p.kind === "clip" || p.kind === "memo" ? p.kind : undefined;
        const items = hits.filter((c) => !c.deleted && (!kind || c.kind === kind));
        return { ok: true, items };
      },
    });

    reg("clip.favorite", {
      description: "Toggle favorite on an item. Favorited clipboard clips are exempt from retention-based deletion.",
      triggers: { ko: "즐겨찾기 토글 보존 고정" },
      params: { id: { type: "string", required: true } },
      returns: "{ itemId, favorite }",
      handler: async (p) => {
        if (typeof p.id !== "string") return err("INVALID_PARAMS", "id 필요");
        const rec = await app.data.get(COLL, p.id);
        if (!rec) return err("TARGET_NOT_FOUND", "항목 없음");
        const favorite = !rec.favorite;
        await app.data.put(COLL, { ...rec, favorite }, { id: p.id });
        return { ok: true, itemId: p.id, favorite };
      },
    });

    reg("clip.category", {
      description: "Move an item to a different category. Rejects the request if the target category does not exist.",
      triggers: { ko: "카테고리 이동 분류 변경" },
      params: { id: { type: "string", required: true }, category: { type: "string", required: true } },
      returns: "{ itemId, category }",
      handler: async (p) => {
        if (typeof p.id !== "string" || typeof p.category !== "string")
          return err("INVALID_PARAMS", "id·category 필요");
        if (!(await catExists(p.category))) return err("TARGET_NOT_FOUND", "없는 카테고리");
        const rec = await app.data.get(COLL, p.id);
        if (!rec) return err("TARGET_NOT_FOUND", "항목 없음");
        await app.data.put(COLL, { ...rec, category: p.category }, { id: p.id });
        return { ok: true, itemId: p.id, category: p.category };
      },
    });

    reg("clip.delete", {
      description: "Soft-delete an item to the trash. Restorable via clip.restore.",
      triggers: { ko: "삭제 휴지통 항목 제거" },
      params: { id: { type: "string", required: true } },
      returns: "{ itemId }",
      handler: async (p) => {
        if (typeof p.id !== "string") return err("INVALID_PARAMS", "id 필요");
        const rec = await app.data.get(COLL, p.id);
        if (!rec) return err("TARGET_NOT_FOUND", "항목 없음");
        await app.data.put(COLL, { ...rec, deleted: true, deletedAt: Date.now() }, { id: p.id });
        return { ok: true, itemId: p.id };
      },
    });

    reg("clip.restore", {
      description: "Restore a trashed item back to its original category.",
      triggers: { ko: "복원 휴지통 되돌리기" },
      params: { id: { type: "string", required: true } },
      returns: "{ itemId }",
      handler: async (p) => {
        if (typeof p.id !== "string") return err("INVALID_PARAMS", "id 필요");
        const rec = await app.data.get(COLL, p.id);
        if (!rec) return err("TARGET_NOT_FOUND", "항목 없음");
        await app.data.put(COLL, { ...rec, deleted: false, deletedAt: null }, { id: p.id });
        return { ok: true, itemId: p.id };
      },
    });

    reg("clip.clear", {
      description: "Hard-delete items permanently. trashOnly=true limits deletion to the trash; kind restricts to clip or memo.",
      triggers: { ko: "전체 삭제 영구 지우기 비우기" },
      params: { trashOnly: { type: "boolean" }, kind: { type: "string" } },
      returns: "{ deleted }",
      handler: async (p) => {
        const all = await app.data.query(COLL, { limit: 100000 });
        const kind = p.kind === "clip" || p.kind === "memo" ? p.kind : undefined;
        let targets = p.trashOnly === true ? all.filter((c) => c.deleted) : all;
        if (kind) targets = targets.filter((c) => c.kind === kind);
        for (const c of targets) await app.data.delete(COLL, c.id);
        return { ok: true, deleted: targets.length };
      },
    });

    reg("clip.count", {
      description: "Count items. trash=true counts the trash; kind restricts to clip or memo.",
      triggers: { ko: "개수 몇 개 카운트" },
      params: { trash: { type: "boolean" }, kind: { type: "string" } },
      returns: "{ count }",
      handler: async (p) => {
        const where = { deleted: p.trash === true };
        if (p.kind === "clip" || p.kind === "memo") where.kind = p.kind;
        const count = await app.data.count(COLL, { where });
        return { ok: true, count };
      },
    });

    reg("clip.state", {
      description: "Summary of counts — clipboard items, memos, favorites, trash, and the configured retention period in days.",
      triggers: { ko: "상태 요약 현황 통계" },
      params: {},
      returns: "{ clips, memos, favorites, trash, retentionDays }",
      handler: async () => {
        const clips = await app.data.count(COLL, { where: { deleted: false, kind: "clip" } });
        const memos = await app.data.count(COLL, { where: { deleted: false, kind: "memo" } });
        const favorites = await app.data.count(COLL, { where: { deleted: false, favorite: true } });
        const trash = await app.data.count(COLL, { where: { deleted: true } });
        return { ok: true, clips, memos, favorites, trash, retentionDays: retentionDays() };
      },
    });

    reg("clip.purge", {
      description: "Immediately delete clipboard items that exceed the retention period, skipping favorites and memos. olderThanMs overrides the retention setting (useful for testing).",
      triggers: { ko: "정리 만료 클립 제거 보존기간" },
      params: { olderThanMs: { type: "number", description: "이 ms 보다 오래된 클립(생략 시 설정 보존일)" } },
      returns: "{ purged }",
      handler: async (p) => {
        if (typeof p.olderThanMs === "number") {
          const cutoff = Date.now() - p.olderThanMs;
          const clips = await app.data.query(COLL, { where: { kind: "clip" }, limit: 100000 });
          const stale = clips.filter((c) => !c.favorite && typeof c.at === "number" && c.at <= cutoff);
          for (const c of stale) await app.data.delete(COLL, c.id);
          return { ok: true, purged: stale.length };
        }
        return { ok: true, purged: await purgeOld() };
      },
    });

    // ── 명령: memo.* (영구) ──────────────────────────────────────────────────
    reg("memo.add", {
      description: "Add a user-authored memo. Memos are permanent and never purged by the retention policy. Category defaults to the default category when omitted.",
      triggers: { ko: "메모 추가 작성 기록" },
      params: { content: { type: "string", required: true }, category: { type: "string" } },
      returns: "{ itemId }",
      examples: ['sok plugin.soksak-plugin-clip.memo.add \'{"content":"기억할 것","category":"기본"}\''],
      handler: async (p) => {
        const content = typeof p.content === "string" ? p.content.trim() : "";
        if (!content) return err("INVALID_PARAMS", "content 필요");
        let category = typeof p.category === "string" && p.category ? p.category : DEFAULT_CAT;
        if (!(await catExists(category))) category = DEFAULT_CAT;
        const id = await app.data.put(COLL, {
          kind: "memo",
          content,
          category,
          copyCount: 0,
          favorite: false,
          deleted: false,
          deletedAt: null,
          at: Date.now(),
        });
        return { ok: true, itemId: id };
      },
    });

    reg("memo.update", {
      description: "Edit the content of an existing memo. Only applies to memo-kind items.",
      triggers: { ko: "메모 수정 편집 내용 변경" },
      params: { id: { type: "string", required: true }, content: { type: "string", required: true } },
      returns: "{ itemId }",
      handler: async (p) => {
        if (typeof p.id !== "string" || typeof p.content !== "string")
          return err("INVALID_PARAMS", "id·content 필요");
        const rec = await app.data.get(COLL, p.id);
        if (!rec || rec.kind !== "memo") return err("TARGET_NOT_FOUND", "메모 없음");
        await app.data.put(COLL, { ...rec, content: p.content.trim() }, { id: p.id });
        return { ok: true, itemId: p.id };
      },
    });

    reg("memo.delete", {
      description: "Soft-delete a memo to the trash. Same as clip.delete but restricted to memo-kind items.",
      triggers: { ko: "메모 삭제 휴지통" },
      params: { id: { type: "string", required: true } },
      returns: "{ itemId }",
      handler: async (p) => {
        if (typeof p.id !== "string") return err("INVALID_PARAMS", "id 필요");
        const rec = await app.data.get(COLL, p.id);
        if (!rec || rec.kind !== "memo") return err("TARGET_NOT_FOUND", "메모 없음");
        await app.data.put(COLL, { ...rec, deleted: true, deletedAt: Date.now() }, { id: p.id });
        return { ok: true, itemId: p.id };
      },
    });

    // ── 명령: category.* ──────────────────────────────────────────────────────
    reg("category.list", {
      description: "List all categories in display order. The default category is always included.",
      triggers: { ko: "카테고리 목록 분류 조회" },
      params: {},
      returns: "{ categories }",
      handler: async () => ({ ok: true, categories: await listCats() }),
    });

    reg("category.add", {
      description: "Add a new category. Idempotent — returns successfully if the name already exists.",
      triggers: { ko: "카테고리 추가 새 분류 생성" },
      params: { name: { type: "string", required: true } },
      returns: "{ name }",
      handler: async (p) => {
        const name = typeof p.name === "string" ? p.name.trim() : "";
        if (!name) return err("INVALID_PARAMS", "name 필요");
        if (await catExists(name)) return { ok: true, name };
        const rows = await app.data.query(CATS, { order: "order", desc: true, limit: 1 });
        const order = rows.length ? (rows[0].order || 0) + 1 : 1;
        await app.data.put(CATS, { name, order });
        return { ok: true, name };
      },
    });

    reg("category.rename", {
      description: "Rename a category and migrate all its items to the new name. The default category cannot be renamed.",
      triggers: { ko: "카테고리 이름변경 분류 수정 이름바꾸기" },
      params: { from: { type: "string", required: true }, to: { type: "string", required: true } },
      returns: "{ moved }",
      handler: async (p) => {
        const from = typeof p.from === "string" ? p.from.trim() : "";
        const to = typeof p.to === "string" ? p.to.trim() : "";
        if (!from || !to) return err("INVALID_PARAMS", "from·to 필요");
        if (from === DEFAULT_CAT) return err("INVALID_PARAMS", "기본 카테고리는 변경 불가");
        const rows = await app.data.query(CATS, { where: { name: from }, limit: 1 });
        if (!rows.length) return err("TARGET_NOT_FOUND", "카테고리 없음");
        if (await catExists(to)) return err("INVALID_PARAMS", "이미 있는 이름");
        await app.data.put(CATS, { ...rows[0], name: to }, { id: rows[0].id });
        const items = await app.data.query(COLL, { where: { category: from }, limit: 100000 });
        for (const it of items) await app.data.put(COLL, { ...it, category: to }, { id: it.id });
        return { ok: true, moved: items.length };
      },
    });

    reg("category.delete", {
      description: "Delete a category and move its items to the default category. The default category itself cannot be deleted.",
      triggers: { ko: "카테고리 삭제 분류 제거" },
      params: { name: { type: "string", required: true } },
      returns: "{ moved }",
      handler: async (p) => {
        const name = typeof p.name === "string" ? p.name.trim() : "";
        if (!name) return err("INVALID_PARAMS", "name 필요");
        if (name === DEFAULT_CAT) return err("INVALID_PARAMS", "기본 카테고리는 삭제 불가");
        const rows = await app.data.query(CATS, { where: { name }, limit: 1 });
        if (!rows.length) return err("TARGET_NOT_FOUND", "카테고리 없음");
        const items = await app.data.query(COLL, { where: { category: name }, limit: 100000 });
        for (const it of items) await app.data.put(COLL, { ...it, category: DEFAULT_CAT }, { id: it.id });
        await app.data.delete(CATS, rows[0].id);
        return { ok: true, moved: items.length };
      },
    });

    // ── 뷰(우측 사이드바) ─────────────────────────────────────────────────────
    const CSS = [
      ".skc-root{display:flex;flex-direction:column;height:100%;font-size:12px;color:var(--fg);}",
      ".skc-head{display:flex;flex-direction:column;gap:8px;padding:10px 10px 9px;border-bottom:1px solid var(--bd-soft);}",
      ".skc-row{display:flex;gap:7px;align-items:center;}",
      ".skc-search{flex:1;box-sizing:border-box;min-height:32px;padding:6px 10px;border-radius:8px;border:1px solid var(--bd-soft);background:color-mix(in srgb,var(--fg) 6%,var(--bg));color:var(--fg);font-size:12px;transition:border-color .12s,box-shadow .12s;}",
      ".skc-search::placeholder{color:var(--fg3);}",
      ".skc-search:focus{border-color:var(--acc);outline:none;box-shadow:0 0 0 3px color-mix(in srgb,var(--acc) 20%,transparent);}",
      ".skc-select{box-sizing:border-box;min-height:30px;appearance:none;-webkit-appearance:none;padding:5px 26px 5px 9px;border-radius:7px;border:1px solid var(--bd-soft);background-color:color-mix(in srgb,var(--fg) 6%,var(--bg));color:var(--fg);font-size:12px;cursor:pointer;background-image:url(\"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='10' height='6'><path d='M1 1l4 4 4-4' fill='none' stroke='%23999' stroke-width='1.4' stroke-linecap='round'/></svg>\");background-repeat:no-repeat;background-position:right 9px center;}",
      ".skc-select:focus{border-color:var(--acc);outline:none;box-shadow:0 0 0 3px color-mix(in srgb,var(--acc) 20%,transparent);}",
      ".skc-iconbtn{flex:none;display:flex;align-items:center;justify-content:center;width:32px;height:32px;border:1px solid var(--bd-soft);background:color-mix(in srgb,var(--fg) 6%,var(--bg));color:var(--fg2);border-radius:8px;cursor:pointer;font-size:15px;line-height:1;transition:all .12s;}",
      ".skc-iconbtn:hover{color:var(--acc);border-color:color-mix(in srgb,var(--acc) 55%,var(--bd-soft));}",
      ".skc-chips{display:flex;gap:6px;flex-wrap:wrap;}",
      ".skc-chip{border:1px solid var(--bd-soft);background:color-mix(in srgb,var(--fg) 5%,var(--bg));color:var(--fg2);padding:3px 10px;border-radius:20px;cursor:pointer;font-size:11px;transition:all .1s;}",
      ".skc-chip:hover{color:var(--fg);border-color:var(--bd);}",
      ".skc-chip.on{background:var(--acc);border-color:var(--acc);color:var(--bg);}",
      ".skc-memobox{display:flex;gap:6px;}",
      ".skc-memoin{flex:1;box-sizing:border-box;min-height:30px;padding:5px 9px;border-radius:7px;border:1px solid var(--bd-soft);background:color-mix(in srgb,var(--fg) 6%,var(--bg));color:var(--fg);font-size:12px;}",
      ".skc-memoin::placeholder{color:var(--fg3);}",
      ".skc-memoin:focus{border-color:var(--acc);outline:none;box-shadow:0 0 0 3px color-mix(in srgb,var(--acc) 20%,transparent);}",
      ".skc-list{flex:1;overflow-y:auto;padding:5px 6px;}",
      ".skc-empty{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:9px;color:var(--fg2);padding:44px 16px;text-align:center;}",
      ".skc-empty svg{opacity:.4;}",
      ".skc-empty-t{font-size:13px;}",
      ".skc-empty-h{font-size:11px;color:var(--fg3);}",
      ".skc-item{display:flex;gap:7px;align-items:flex-start;padding:7px 8px;border-radius:8px;transition:background .1s;}",
      ".skc-item:hover{background:color-mix(in srgb,var(--fg) 6%,var(--bg));}",
      ".skc-main{flex:1;min-width:0;}",
      ".skc-prev{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}",
      ".skc-meta{display:flex;gap:6px;align-items:center;font-size:10px;color:var(--fg3);margin-top:3px;white-space:nowrap;overflow:hidden;}",
      ".skc-kind{flex:none;padding:1px 7px;border-radius:8px;border:1px solid;font-size:9px;line-height:1.5;white-space:nowrap;}",
      ".skc-kind.memo{color:color-mix(in srgb,#c08cff 82%,var(--fg));border-color:color-mix(in srgb,#c08cff 42%,transparent);}",
      ".skc-kind.clip{color:color-mix(in srgb,#52cfe6 82%,var(--fg));border-color:color-mix(in srgb,#52cfe6 42%,transparent);}",
      ".skc-cat{flex:none;max-width:90px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--fg3);}",
      ".skc-time{flex:none;color:var(--fg3);}",
      ".skc-btn{flex:none;border:0;background:none;padding:2px 5px;border-radius:4px;color:var(--fg3);cursor:pointer;}",
      ".skc-btn:hover{color:var(--fg);background:var(--bd);}",
      ".skc-btn.fav.on{color:var(--acc);}",
    ].join("");

    const nodeKey = (id) => {
      const s = String(id).toLowerCase().replace(/[^a-z0-9.-]/g, "-");
      return /^[a-z0-9]/.test(s) ? s : "k-" + s;
    };

    sub(
      app.ui.registerView("clips", {
        mount(container, vctx) {
          container.textContent = "";
          const style = document.createElement("style");
          style.textContent = CSS;
          const root = document.createElement("div");
          root.className = "skc-root";
          const head = document.createElement("div");
          head.className = "skc-head";

          const row1 = document.createElement("div");
          row1.className = "skc-row";
          const searchInput = document.createElement("input");
          searchInput.className = "skc-search";
          searchInput.type = "text";
          searchInput.placeholder = "검색…";
          searchInput.dataset.node = "search-input";
          const addCatBtn = document.createElement("button");
          addCatBtn.className = "skc-iconbtn";
          addCatBtn.type = "button";
          addCatBtn.textContent = "＋";
          addCatBtn.title = "카테고리 추가";
          row1.append(searchInput, addCatBtn);

          const row2 = document.createElement("div");
          row2.className = "skc-row";
          const catSel = document.createElement("select");
          catSel.className = "skc-select";
          catSel.dataset.node = "category-select";
          row2.append(catSel);

          const chips = document.createElement("div");
          chips.className = "skc-chips";
          const mk = (label, node) => {
            const b = document.createElement("button");
            b.className = "skc-chip";
            b.type = "button";
            b.textContent = label;
            b.dataset.node = node;
            return b;
          };
          const clipChip = mk("클립보드", "kind-clip");
          const memoChip = mk("메모", "kind-memo");
          const favChip = mk("★", "fav-filter");
          const trashChip = mk("🗑", "trash-filter");
          chips.append(clipChip, memoChip, favChip, trashChip);

          const memoBox = document.createElement("div");
          memoBox.className = "skc-memobox";
          const memoIn = document.createElement("input");
          memoIn.className = "skc-memoin";
          memoIn.type = "text";
          memoIn.placeholder = "메모 추가… (Enter)";
          memoIn.dataset.node = "memo-input";
          const memoAdd = document.createElement("button");
          memoAdd.className = "skc-iconbtn";
          memoAdd.type = "button";
          memoAdd.textContent = "✚";
          memoAdd.title = "메모 추가";
          memoAdd.dataset.node = "memo-add";
          memoBox.append(memoIn, memoAdd);

          head.append(row1, row2, chips, memoBox);

          const listEl = document.createElement("div");
          listEl.className = "skc-list";
          root.append(head, listEl);
          container.append(style, root);

          let searchTerm = "";
          let kindFilter = "";
          let favOnly = false;
          let trashView = false;
          let category = "";
          let searchTimer = null;

          // 상대 시간(짧게 — 좁은 사이드바). 방금/N분 전/N시간 전/N일 전, 그 이상은 M/D.
          const fmtTime = (ts) => {
            if (typeof ts !== "number") return "";
            const d = Date.now() - ts;
            if (d < 60000) return "방금";
            if (d < 3600000) return `${Math.floor(d / 60000)}분 전`;
            if (d < 86400000) return `${Math.floor(d / 3600000)}시간 전`;
            if (d < 604800000) return `${Math.floor(d / 86400000)}일 전`;
            try {
              const x = new Date(ts);
              return `${x.getMonth() + 1}/${x.getDate()}`;
            } catch {
              return "";
            }
          };
          const preview = (t) => {
            const line = String(t).split("\n").find((l) => l.trim()) || String(t);
            return line.trim();
          };

          const fillCats = async () => {
            const cats = await listCats();
            catSel.textContent = "";
            const optAll = document.createElement("option");
            optAll.value = "";
            optAll.textContent = "전체 카테고리";
            catSel.append(optAll);
            for (const name of cats) {
              const o = document.createElement("option");
              o.value = name;
              o.textContent = name;
              catSel.append(o);
            }
            catSel.value = category;
          };

          const renderRows = (items) => {
            listEl.textContent = "";
            if (!items.length) {
              const empty = document.createElement("div");
              empty.className = "skc-empty";
              const icon = document.createElement("span");
              icon.innerHTML =
                "<svg width='38' height='38' viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'><rect x='8' y='3' width='13' height='15' rx='2'/><path d='M3 7v13a2 2 0 0 0 2 2h11'/></svg>";
              const t = document.createElement("div");
              t.className = "skc-empty-t";
              const h = document.createElement("div");
              h.className = "skc-empty-h";
              t.textContent = searchTerm
                ? "검색 결과가 없습니다"
                : trashView
                  ? "휴지통이 비었습니다"
                  : kindFilter === "memo"
                    ? "메모가 없습니다"
                    : "복사하거나 메모를 추가하세요";
              h.textContent = trashView ? "" : "복사하면 자동으로 모이고, 아래에 메모를 적을 수 있습니다";
              empty.append(icon, t, h);
              listEl.append(empty);
              return;
            }
            for (const c of items) {
              const key = nodeKey(c.id);
              const row = document.createElement("div");
              row.className = "skc-item";
              row.dataset.node = "item/" + key;
              const main = document.createElement("div");
              main.className = "skc-main";
              const prev = document.createElement("div");
              prev.className = "skc-prev";
              prev.textContent = preview(c.content);
              const meta = document.createElement("div");
              meta.className = "skc-meta";
              const kind = document.createElement("span");
              kind.className = "skc-kind " + (c.kind === "memo" ? "memo" : "clip");
              kind.textContent = c.kind === "memo" ? "메모" : "클립보드";
              const cat = document.createElement("span");
              cat.className = "skc-cat";
              cat.textContent = c.category || DEFAULT_CAT;
              const time = document.createElement("span");
              time.className = "skc-time";
              const n = c.copyCount || 0;
              time.textContent = (c.kind === "clip" && n > 1 ? `×${n} · ` : "") + fmtTime(c.at);
              meta.append(kind, cat, time);
              main.append(prev, meta);

              const fav = document.createElement("button");
              fav.className = "skc-btn fav" + (c.favorite ? " on" : "");
              fav.type = "button";
              fav.textContent = c.favorite ? "★" : "☆";
              fav.title = "즐겨찾기";
              fav.dataset.node = "item-fav/" + key;
              fav.addEventListener("click", () => {
                void app.data.put(COLL, { ...c, favorite: !c.favorite }, { id: c.id });
              });

              const del = document.createElement("button");
              del.className = "skc-btn";
              del.type = "button";
              del.dataset.node = "item-del/" + key;
              if (trashView) {
                del.textContent = "↩";
                del.title = "복원";
                del.addEventListener("click", () => {
                  void app.data.put(COLL, { ...c, deleted: false, deletedAt: null }, { id: c.id });
                });
              } else {
                del.textContent = "✕";
                del.title = "삭제";
                del.addEventListener("click", () => {
                  void app.data.put(COLL, { ...c, deleted: true, deletedAt: Date.now() }, { id: c.id });
                });
              }
              row.append(main, fav, del);
              listEl.append(row);
            }
          };

          const refresh = async () => {
            try {
              await fillCats();
              let items;
              if (searchTerm && !trashView) {
                const hits = await app.data.search(COLL, searchTerm, { limit: 300 });
                items = hits.filter(
                  (c) =>
                    !c.deleted &&
                    (!favOnly || c.favorite) &&
                    (!kindFilter || c.kind === kindFilter) &&
                    (!category || c.category === category),
                );
              } else {
                items = await listItems({
                  kind: kindFilter || undefined,
                  category: category || undefined,
                  favorite: favOnly,
                  trash: trashView,
                  limit: 300,
                });
              }
              renderRows(items);
              if (vctx.setBadge) {
                const active = await app.data.count(COLL, { where: { deleted: false } });
                vctx.setBadge(active || null);
              }
            } catch (e) {
              console.warn("[clip] refresh 실패:", e);
            }
          };

          searchInput.addEventListener("input", () => {
            searchTerm = searchInput.value.trim();
            if (searchTimer) clearTimeout(searchTimer);
            searchTimer = setTimeout(() => void refresh(), 180);
          });
          catSel.addEventListener("change", () => {
            category = catSel.value;
            void refresh();
          });
          // clip/memo 칩 상호배타.
          clipChip.addEventListener("click", () => {
            kindFilter = kindFilter === "clip" ? "" : "clip";
            clipChip.classList.toggle("on", kindFilter === "clip");
            memoChip.classList.toggle("on", false);
            void refresh();
          });
          memoChip.addEventListener("click", () => {
            kindFilter = kindFilter === "memo" ? "" : "memo";
            memoChip.classList.toggle("on", kindFilter === "memo");
            clipChip.classList.toggle("on", false);
            void refresh();
          });
          favChip.addEventListener("click", () => {
            favOnly = !favOnly;
            favChip.classList.toggle("on", favOnly);
            void refresh();
          });
          trashChip.addEventListener("click", () => {
            trashView = !trashView;
            trashChip.classList.toggle("on", trashView);
            void refresh();
          });

          const doAddMemo = async () => {
            const text = memoIn.value.trim();
            if (!text) return;
            await app.data.put(COLL, {
              kind: "memo",
              content: text,
              category: category || DEFAULT_CAT,
              copyCount: 0,
              favorite: false,
              deleted: false,
              deletedAt: null,
              at: Date.now(),
            });
            memoIn.value = "";
          };
          memoAdd.addEventListener("click", () => void doAddMemo());
          memoIn.addEventListener("keydown", (e) => {
            if (e.key === "Enter") void doAddMemo();
          });

          addCatBtn.addEventListener("click", async () => {
            const name = window.prompt("새 카테고리 이름");
            if (!name || !name.trim()) return;
            await app.commands.execute("plugin.soksak-plugin-clip.category.add", { name: name.trim() });
            void refresh();
          });

          const entry = { refresh };
          mounts.add(entry);
          container.__skcEntry = entry;
          void refresh();
        },
        unmount(container) {
          if (container.__skcEntry) {
            mounts.delete(container.__skcEntry);
            container.__skcEntry = null;
          }
          container.textContent = "";
        },
      }),
    );

    const onChange = () => {
      for (const m of mounts) void m.refresh();
    };
    sub(app.data.watch(COLL, undefined, onChange));
    sub(app.data.watch(CATS, undefined, onChange));

    void Promise.all([
      app.data.define(COLL, {
        indexes: ["kind", "category", "favorite", "deleted", "copyCount", "at"],
        fts: ["content"],
      }),
      app.data.define(CATS, { indexes: ["order", "name"], fts: [] }),
    ])
      .then(async () => {
        await ensureDefaultCategory();
        await purgeOld().catch(() => {});
        onChange();
      })
      .catch((e) => console.error("[clip] 초기화 실패:", e));
  },

  deactivate() {},
};
