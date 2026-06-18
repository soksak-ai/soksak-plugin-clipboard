// 클립보드 히스토리 플러그인 — 시스템 클립보드 복사 이력을 자동으로 모은다.
// 데이터는 코어 app.data(SQLite, CJK 전문검색), 실시간은 app.data.watch(크로스윈도우, 폴링 0).
// 자동 캡처는 app.clipboard.watch(코어가 OS별 변경 이벤트를 단일 신호로 흡수 — 플러그인은 OS 분기를 안 봄).
//
// [스코프] = 전역(프로젝트 무관). 클립보드는 OS 단일 자원이라 프로젝트별로 가르지 않는다 → scope 생략.
//
// [v1 범위] 자동 캡처 · dedup(같은 내용 합쳐 copyCount 증가) · CJK 검색 · 즐겨찾기 ·
//   휴지통(소프트 삭제 deletedAt · 복원) · 전체 삭제 · 1줄 미리보기.
// [후속(이번 제외)]
//   - Apple 메모 내보내기: macOS osascript 의존(플랫폼 종속) → R5 위반이라 코어 capability 선행 필요.
//   - 클립 → runbook 명령 등록: runbook 플러그인 + 교차 플러그인 연동 필요.
//   - 풀 캘린더 날짜 필터 그리드: v1 은 행 메타(복사 시각)로 충분 → 후속에서 그리드.

const COLL = "clips";

export default {
  activate(ctx) {
    const app = ctx.app;
    const sub = (d) => ctx.subscriptions.push(d);

    const mounts = new Set(); // 마운트된 뷰 — data 변경 시 전 창 refresh 라우팅
    const err = (code, message) => ({ ok: false, code, message });

    // [삭제 상태 모델] 소프트 삭제는 boolean `deleted`(false/true)로 표현하고, `deletedAt`(ms|null)는
    // 표시·정렬용 메타로만 둔다. SQL 에서 `json_extract = NULL` 은 항상 거짓이라 null 필드로는
    // where 필터가 안 된다(band-aid 금지 — 구조로 해결). boolean 은 0/1 로 추출돼 정상 비교된다.

    // ── 단일 캡처 유틸(R8) — watch 자동 캡처와 clipboard.capture 명령이 공유. dedup 판정도 여기 한 곳.
    // trim 후 빈 건 무시. 비삭제(deleted==false) 동일 content 가 있으면 그 레코드 copyCount++ 후
    // put 갱신(최신화), 없으면 신규 put. 반환 = { clipId, deduped }.
    async function captureText(raw) {
      const content = typeof raw === "string" ? raw.trim() : "";
      if (!content) return null;
      // 동일 비삭제 클립 탐색 — content 는 fts 필드(인덱스 아님)라 where eq 불가 →
      // search 로 후보를 좁힌 뒤 JS 에서 정확 일치(===)·비삭제만 채택(검색은 부분일치라 == 로 확정).
      const candidates = await app.data.search(COLL, content, { limit: 50 });
      const existing = candidates.find((c) => c.content === content && !c.deleted);
      if (existing) {
        await app.data.put(
          COLL,
          { ...existing, copyCount: (existing.copyCount || 1) + 1 },
          { id: existing.id },
        );
        return { clipId: existing.id, deduped: true };
      }
      const id = await app.data.put(COLL, {
        content,
        copyCount: 1,
        favorite: false,
        deleted: false,
        deletedAt: null,
      });
      return { clipId: id, deduped: false };
    }

    // ── 자동 캡처: 코어 clipboard-change 구독(폴링 macOS 한정, 코어가 흡수). self-write echo 는
    // 코어가 1회 억제하므로 사용자 복사만 들어온다.
    sub(app.clipboard.watch((e) => void captureText(e.text)));

    // ── 커맨드(전 기능 노출 — UI 없이 E2E 전부 가능, R7) ──

    sub(
      app.commands.register("clipboard.capture", {
        description:
          "텍스트를 클립 이력에 캡처(자동 캡처와 동일 경로 — 같은 내용은 copyCount 증가). 헤드리스 검증·수동 추가용",
        params: { text: { type: "string", required: true, description: "캡처할 텍스트" } },
        returns: "{ clipId, deduped }",
        examples: ['sok plugin.soksak-plugin-clipboard.clipboard.capture \'{"text":"테스트"}\''],
        handler: async (p) => {
          if (typeof p.text !== "string") return err("INVALID_PARAMS", "text 필요");
          const r = await captureText(p.text);
          if (!r) return err("INVALID_PARAMS", "빈 텍스트는 캡처하지 않음");
          return { ok: true, ...r };
        },
      }),
    );

    sub(
      app.commands.register("clipboard.list", {
        description:
          "클립 목록(최신순). favorite=true 면 즐겨찾기만, trash=true 면 휴지통(삭제됨)만",
        params: {
          limit: { type: "number", description: "최대 건수(기본 200)" },
          offset: { type: "number", description: "페이지네이션" },
          favorite: { type: "boolean", description: "즐겨찾기만" },
          trash: { type: "boolean", description: "휴지통(삭제됨)만" },
        },
        returns: "{ clips }",
        examples: ["sok plugin.soksak-plugin-clipboard.clipboard.list"],
        handler: async (p) => {
          const clips = await listClips({
            favorite: p.favorite === true,
            trash: p.trash === true,
            limit: typeof p.limit === "number" ? p.limit : 200,
            offset: typeof p.offset === "number" ? p.offset : undefined,
          });
          return { ok: true, clips };
        },
      }),
    );

    sub(
      app.commands.register("clipboard.search", {
        description: "클립 CJK 전문검색(내용). 휴지통 제외.",
        params: {
          query: { type: "string", required: true, description: "검색어" },
          limit: { type: "number", description: "최대 건수(기본 100)" },
        },
        returns: "{ clips }",
        examples: ['sok plugin.soksak-plugin-clipboard.clipboard.search \'{"query":"테스트"}\''],
        handler: async (p) => {
          if (typeof p.query !== "string") return err("INVALID_PARAMS", "query 필요");
          const hits = await app.data.search(COLL, p.query, {
            limit: typeof p.limit === "number" ? p.limit : 100,
          });
          // 검색은 휴지통 포함이므로 비삭제만 남긴다(목록 계약과 일관).
          const clips = hits.filter((c) => !c.deleted);
          return { ok: true, clips };
        },
      }),
    );

    sub(
      app.commands.register("clipboard.favorite", {
        description: "즐겨찾기 토글(있으면 해제, 없으면 설정)",
        params: { id: { type: "string", required: true, description: "클립 id" } },
        returns: "{ clipId, favorite }",
        handler: async (p) => {
          if (typeof p.id !== "string") return err("INVALID_PARAMS", "id 필요");
          const rec = await app.data.get(COLL, p.id);
          if (!rec) return err("TARGET_NOT_FOUND", "클립 없음");
          const favorite = !rec.favorite;
          await app.data.put(COLL, { ...rec, favorite }, { id: p.id });
          return { ok: true, clipId: p.id, favorite };
        },
      }),
    );

    sub(
      app.commands.register("clipboard.delete", {
        description: "클립 휴지통으로 보내기(소프트 삭제 — deletedAt 표시). 복원 가능.",
        params: { id: { type: "string", required: true, description: "클립 id" } },
        returns: "{ clipId }",
        handler: async (p) => {
          if (typeof p.id !== "string") return err("INVALID_PARAMS", "id 필요");
          const rec = await app.data.get(COLL, p.id);
          if (!rec) return err("TARGET_NOT_FOUND", "클립 없음");
          await app.data.put(COLL, { ...rec, deleted: true, deletedAt: Date.now() }, { id: p.id });
          return { ok: true, clipId: p.id };
        },
      }),
    );

    sub(
      app.commands.register("clipboard.restore", {
        description: "휴지통의 클립 복원(deletedAt 해제)",
        params: { id: { type: "string", required: true, description: "클립 id" } },
        returns: "{ clipId }",
        handler: async (p) => {
          if (typeof p.id !== "string") return err("INVALID_PARAMS", "id 필요");
          const rec = await app.data.get(COLL, p.id);
          if (!rec) return err("TARGET_NOT_FOUND", "클립 없음");
          await app.data.put(COLL, { ...rec, deleted: false, deletedAt: null }, { id: p.id });
          return { ok: true, clipId: p.id };
        },
      }),
    );

    sub(
      app.commands.register("clipboard.clear", {
        description: "클립 전체 삭제(하드). trashOnly=true 면 휴지통만 비운다.",
        params: { trashOnly: { type: "boolean", description: "휴지통만 비우기" } },
        returns: "{ deleted }",
        handler: async (p) => {
          const all = await app.data.query(COLL, { limit: 100000 });
          const targets = p.trashOnly === true ? all.filter((c) => c.deleted) : all;
          for (const c of targets) await app.data.delete(COLL, c.id);
          return { ok: true, deleted: targets.length };
        },
      }),
    );

    sub(
      app.commands.register("clipboard.count", {
        description: "클립 개수. trash=true 면 휴지통 개수, 아니면 비휴지통 개수.",
        params: { trash: { type: "boolean", description: "휴지통 개수" } },
        returns: "{ count }",
        handler: async (p) => {
          const count = await app.data.count(COLL, { where: { deleted: p.trash === true } });
          return { ok: true, count };
        },
      }),
    );

    sub(
      app.commands.register("clipboard.state", {
        description: "상태 요약(introspection) — 활성/즐겨찾기/휴지통 개수.",
        params: {},
        returns: "{ active, favorites, trash }",
        handler: async () => {
          const active = await app.data.count(COLL, { where: { deleted: false } });
          const favorites = await app.data.count(COLL, {
            where: { deleted: false, favorite: true },
          });
          const trash = await app.data.count(COLL, { where: { deleted: true } });
          return { ok: true, active, favorites, trash };
        },
      }),
    );

    // ── 목록 질의 유틸(명령·뷰 공유) — 휴지통/즐겨찾기 필터. copyCount 정렬은 별도 명령 인자 없이
    // 최신(updated) 우선(가장 최근 복사가 위로). 휴지통은 deletedAt 최신순.
    async function listClips({ favorite, trash, limit, offset }) {
      const where = trash
        ? { deleted: true }
        : favorite
          ? { deleted: false, favorite: true }
          : { deleted: false };
      return app.data.query(COLL, {
        where,
        order: "updated",
        desc: true,
        limit: limit ?? 200,
        offset,
      });
    }

    // ── 뷰(우측 사이드바). 실시간 = app.data.watch(크로스윈도우, 폴링 0). ──
    const CSS = [
      ".skcb-root{display:flex;flex-direction:column;height:100%;font-size:12px;color:var(--fg);}",
      ".skcb-head{display:flex;flex-direction:column;gap:6px;padding:6px 8px;border-bottom:1px solid var(--bd-soft);}",
      ".skcb-search{width:100%;box-sizing:border-box;padding:4px 8px;border-radius:6px;border:1px solid var(--bd-soft);background:var(--bg);color:var(--fg);font-size:12px;}",
      ".skcb-search::placeholder{color:var(--fg3);}",
      ".skcb-filters{display:flex;gap:6px;}",
      ".skcb-tg{flex:1;border:1px solid var(--bd-soft);background:var(--bg);color:var(--fg2);padding:3px 6px;border-radius:6px;cursor:pointer;font-size:11px;}",
      ".skcb-tg:hover{color:var(--fg);border-color:var(--bd);}",
      ".skcb-tg.on{background:var(--acc);border-color:var(--acc);color:var(--bg);}",
      ".skcb-list{flex:1;overflow-y:auto;padding:4px;}",
      ".skcb-empty{color:var(--fg2);padding:14px;text-align:center;}",
      ".skcb-row{display:flex;gap:6px;align-items:flex-start;padding:6px;border-radius:6px;}",
      ".skcb-row:hover{background:var(--bg);}",
      ".skcb-main{flex:1;min-width:0;}",
      ".skcb-prev{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}",
      ".skcb-meta{font-size:10.5px;color:var(--fg3);margin-top:1px;}",
      ".skcb-btn{flex:none;border:0;background:none;padding:2px 5px;border-radius:4px;color:var(--fg3);cursor:pointer;}",
      ".skcb-btn:hover{color:var(--fg);background:var(--bd);}",
      ".skcb-btn.fav.on{color:var(--acc);}",
    ].join("");

    // node path 안정키 정제 — 세그먼트 형식(^[a-z0-9][a-z0-9.-]*$). 코어 자동 id 는 부합하나
    // 임의 import id 도 결정적으로 매핑(인덱스 아님 — 멱등).
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
          root.className = "skcb-root";

          const head = document.createElement("div");
          head.className = "skcb-head";
          const searchInput = document.createElement("input");
          searchInput.className = "skcb-search";
          searchInput.type = "text";
          searchInput.placeholder = "검색…";
          searchInput.dataset.node = "search-input";
          const filters = document.createElement("div");
          filters.className = "skcb-filters";
          const favTg = document.createElement("button");
          favTg.className = "skcb-tg";
          favTg.type = "button";
          favTg.textContent = "★ 즐겨찾기";
          favTg.dataset.node = "fav-filter";
          const trashTg = document.createElement("button");
          trashTg.className = "skcb-tg";
          trashTg.type = "button";
          trashTg.textContent = "🗑 휴지통";
          trashTg.dataset.node = "trash-filter";
          filters.append(favTg, trashTg);
          head.append(searchInput, filters);

          const listEl = document.createElement("div");
          listEl.className = "skcb-list";
          root.append(head, listEl);
          container.append(style, root);

          let searchTerm = "";
          let favOnly = false;
          let trashView = false;
          let searchTimer = null;

          const fmtTime = (ts) => {
            try {
              return new Date(ts).toLocaleString();
            } catch {
              return "";
            }
          };
          const preview = (text) => {
            const line = String(text).split("\n").find((l) => l.trim()) || String(text);
            return line.trim();
          };

          const renderRows = (clips) => {
            listEl.textContent = "";
            if (!clips.length) {
              const empty = document.createElement("div");
              empty.className = "skcb-empty";
              empty.textContent = searchTerm
                ? "검색 결과가 없습니다"
                : trashView
                  ? "휴지통이 비었습니다"
                  : favOnly
                    ? "즐겨찾기가 없습니다"
                    : "복사한 내용이 없습니다";
              listEl.append(empty);
              return;
            }
            for (const c of clips) {
              const key = nodeKey(c.id);
              const row = document.createElement("div");
              row.className = "skcb-row";
              row.dataset.node = "clip-item/" + key;

              const main = document.createElement("div");
              main.className = "skcb-main";
              const prev = document.createElement("div");
              prev.className = "skcb-prev";
              prev.textContent = preview(c.content); // 외부 데이터 = textContent만(XSS 안전)
              const meta = document.createElement("div");
              meta.className = "skcb-meta";
              const n = c.copyCount || 1;
              meta.textContent = (n > 1 ? `×${n} · ` : "") + fmtTime(c.updated);
              main.append(prev, meta);

              const fav = document.createElement("button");
              fav.className = "skcb-btn fav" + (c.favorite ? " on" : "");
              fav.type = "button";
              fav.textContent = c.favorite ? "★" : "☆";
              fav.title = "즐겨찾기";
              fav.dataset.node = "clip-fav/" + key;
              fav.addEventListener("click", () => {
                void app.data.put(COLL, { ...c, favorite: !c.favorite }, { id: c.id });
              });

              const del = document.createElement("button");
              del.className = "skcb-btn";
              del.type = "button";
              if (trashView) {
                del.textContent = "↩";
                del.title = "복원";
                del.dataset.node = "clip-del/" + key; // 휴지통에선 같은 슬롯이 복원
                del.addEventListener("click", () => {
                  void app.data.put(COLL, { ...c, deleted: false, deletedAt: null }, { id: c.id });
                });
              } else {
                del.textContent = "✕";
                del.title = "삭제";
                del.dataset.node = "clip-del/" + key;
                del.addEventListener("click", () => {
                  void app.data.put(
                    COLL,
                    { ...c, deleted: true, deletedAt: Date.now() },
                    { id: c.id },
                  );
                });
              }

              row.append(main, fav, del);
              listEl.append(row);
            }
          };

          const refresh = async () => {
            try {
              let clips;
              if (searchTerm && !trashView) {
                const hits = await app.data.search(COLL, searchTerm, { limit: 200 });
                clips = hits.filter((c) => !c.deleted && (!favOnly || c.favorite));
              } else {
                clips = await listClips({ favorite: favOnly, trash: trashView, limit: 300 });
              }
              renderRows(clips);
              if (vctx.setBadge) {
                const active = await app.data.count(COLL, { where: { deleted: false } });
                vctx.setBadge(active || null);
              }
            } catch (e) {
              console.warn("[clipboard] refresh 실패:", e);
            }
          };

          searchInput.addEventListener("input", () => {
            searchTerm = searchInput.value.trim();
            if (searchTimer) clearTimeout(searchTimer);
            searchTimer = setTimeout(() => void refresh(), 180);
          });
          favTg.addEventListener("click", () => {
            favOnly = !favOnly;
            favTg.classList.toggle("on", favOnly);
            void refresh();
          });
          trashTg.addEventListener("click", () => {
            trashView = !trashView;
            trashTg.classList.toggle("on", trashView);
            void refresh();
          });

          const entry = { refresh };
          mounts.add(entry);
          container.__skcbEntry = entry;
          void refresh();
        },
        unmount(container) {
          if (container.__skcbEntry) {
            mounts.delete(container.__skcbEntry);
            container.__skcbEntry = null;
          }
          container.textContent = "";
        },
      }),
    );

    // 데이터 변경 → 전 창 뷰 재질의(같은 클립 이력 다중 창 일관, 폴링 0).
    sub(
      app.data.watch(COLL, undefined, () => {
        for (const m of mounts) void m.refresh();
      }),
    );

    // 컬렉션 정의(멱등). content=FTS(CJK), favorite/deleted/copyCount=구조 질의.
    // [주의] 소프트삭제 필터는 boolean `deleted` 를 인덱스로 둔다 — null `deletedAt` 은 SQL
    // json_extract=NULL 이 항상 거짓이라 where 필터가 안 된다(deletedAt 은 표시용 메타).
    void app.data
      .define(COLL, { indexes: ["favorite", "deleted", "copyCount"], fts: ["content"] })
      .then(() => {
        for (const m of mounts) void m.refresh();
      })
      .catch((e) => console.error("[clipboard] 초기화 실패:", e));
  },

  deactivate() {
    // 등록물·구독은 ctx.subscriptions/호스트 tracker 가 자동 수거.
  },
};
