// ==UserScript==
// @name         DoorDash Modifier Collector — Menu Maker Bridge
// @namespace    popmenu
// @version      5.8
// @description  Collects DoorDash menu data, sends it to Menu Maker via Supabase Realtime, and announces bridge presence on Menu Maker
// @match        https://www.doordash.com/*
// @match        https://*.lovable.app/*
// @match        https://order.online/*
// @match        https://jooj211.github.io/doordash-bridge/*
// @match        http://127.0.0.1/*
// @match        http://localhost/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
  "use strict";

  // ─── Supabase config ──────────────────────────────────────────────────────
  const SUPABASE_URL = "https://gfykqhofnsdisbgnpjyt.supabase.co";
  const SUPABASE_KEY =
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImdmeWtxaG9mbnNkaXNiZ25wanl0Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzIyMTcyMjAsImV4cCI6MjA4Nzc5MzIyMH0.9tLD6TfmHCVht1TE9SlYWFa-d1hSRrxv-Z09a8FgIx0";
  const CHANNEL_PREFIX = "doordash-collect";
  const BRIDGE_PING_EVENT = "menu-maker:doordash-bridge-ping";
  const BRIDGE_STATUS_EVENT = "menu-maker:doordash-bridge-status";
  const BRIDGE_MESSAGE_TYPE = "menu-maker:doordash-menu-collected";
  const BRIDGE_VERSION = "5.8";
  const isDoorDashHost = /(^|\.)doordash\.com$/i.test(window.location.hostname);
  const isGitHubPagesMenuMakerHost =
    window.location.hostname === "jooj211.github.io" &&
    /^\/doordash-bridge(?:\/|$)/.test(window.location.pathname);
  const isMenuMakerHost =
    window.location.hostname === "127.0.0.1" ||
    window.location.hostname === "localhost" ||
    /(^|\.)order\.online$/i.test(window.location.hostname) ||
    isGitHubPagesMenuMakerHost ||
    /(^|\.)lovable\.app$/i.test(window.location.hostname);

  const announceBridgePresence = () => {
    const detail = {
      installed: true,
      version: BRIDGE_VERSION,
      source: "doordash_bridge",
      origin: window.location.origin,
    };
    window.__MM_DOORDASH_BRIDGE__ = detail;
    window.dispatchEvent(
      new CustomEvent(BRIDGE_STATUS_EVENT, {
        detail,
      }),
    );
  };

  if (!isDoorDashHost) {
    if (isMenuMakerHost) {
      announceBridgePresence();
      window.addEventListener(BRIDGE_PING_EVENT, announceBridgePresence);
    }
    return;
  }

  // ─── Session detection ────────────────────────────────────────────────────
  const MM_SESSION = new URLSearchParams(window.location.search).get(
    "mm_session",
  );
  const AUTO_MODE = !!MM_SESSION;

  // ─── State ────────────────────────────────────────────────────────────────
  const state = {
    storeId: null,
    menuId: null,
    storeName: null,
    items: [],
    itemDataById: {},
    isCollecting: false,
    totalToCollect: 0,
    collected: 0,
    errors: 0,
    published: false,
  };

  const isRecommendedModifierGroup = (group) => {
    const name = (group?.name || "").toLowerCase().trim();
    if (!name) return false;

    const looksPromotional =
      /\brecommended\b/.test(name) ||
      /\bsuggested\b/.test(name) ||
      /\bpopular\b/.test(name) ||
      /\bmost ordered\b/.test(name) ||
      /\bpeople also\b/.test(name) ||
      /\bfrequently bought\b/.test(name) ||
      /\bcomplete your meal\b/.test(name) ||
      /\byou might also like\b/.test(name) ||
      /\bpairs? well with\b/.test(name) ||
      /\bmake it a combo\b/.test(name) ||
      /\badd a drink\b/.test(name) ||
      /\bdrinks? with (your|this)\b/.test(name) ||
      /\bbeverage\b/.test(name);

    return (
      looksPromotional && !(group?.required || (group?.minSelect || 0) > 0)
    );
  };

  // ─── Apollo helpers ───────────────────────────────────────────────────────

  const waitForApollo = (cb, retries = 30) => {
    if (window.__APOLLO_CLIENT__) {
      cb();
      return;
    }
    if (retries <= 0) return;
    setTimeout(() => waitForApollo(cb, retries - 1), 300);
  };

  const waitForFeed = (cb, retries = 40) => {
    const apollo = window.__APOLLO_CLIENT__;
    if (apollo) {
      const rootQuery = apollo.cache.data.data?.["ROOT_QUERY"] || {};
      const feedKeys = Object.keys(rootQuery).filter((k) =>
        k.startsWith("storepageFeed"),
      );
      const feedKey =
        feedKeys.find(
          (k) =>
            k.includes("Delivery") &&
            /"menuId":"\d+"/.test(k) &&
            rootQuery[k]?.itemLists?.some((l) => l.items?.length > 0),
        ) ||
        feedKeys.find((k) =>
          rootQuery[k]?.itemLists?.some((l) => l.items?.length > 0),
        );
      const feed = feedKey ? rootQuery[feedKey] : null;
      if (feed) {
        cb(feedKey, feed);
        return;
      }
    }
    if (retries <= 0) {
      cb(null, null);
      return;
    }
    setTimeout(() => waitForFeed(cb, retries - 1), 400);
  };

  const parseIds = (feedKey) => {
    const storeId = feedKey?.match(/"storeId":"(\d+)"/)?.[1] || null;
    let menuId = parseInt(feedKey?.match(/"menuId":"(\d+)"/)?.[1] || "0");
    if (!menuId) {
      const pathParts = window.location.pathname.split("/").filter(Boolean);
      menuId = parseInt(pathParts[pathParts.length - 1]) || 0;
    }
    return { storeId, menuId };
  };

  const extractItems = (feed) => {
    const items = [];
    for (const list of feed.itemLists || []) {
      const category = list.name || "Uncategorized";
      const categoryDescription =
        list.description ||
        list.subtitle ||
        list.subtext ||
        list.headerDescription ||
        null;
      for (const item of list.items || []) {
        if (!item.id) continue;
        let categoryId = null;
        try {
          const cursor = item.nextCursor;
          if (cursor) {
            const decoded = JSON.parse(atob(cursor));
            categoryId = decoded.categoryId || null;
          }
        } catch (e) {
          /* ignore */
        }
        items.push({
          id: item.id,
          name: item.name || "",
          description: item.description || "",
          price: item.displayPrice || "",
          category,
          categoryDescription,
          categoryId,
        });
      }
    }
    return items;
  };

  const buildCursor = (itemId, categoryId) => {
    const obj = {
      dm_id: "item_1",
      dm_type: "item",
      dm_version: 2,
      cursor_version: "ITEM_PAGE",
      itemId: parseInt(itemId),
      optionId: null,
      selectedOrderItemId: null,
      storeLiteData: null,
      is_homegrown_loyalty: false,
      page_stack_trace: [],
      storeId: parseInt(state.storeId),
      menuId: state.menuId,
      categoryId: categoryId ? parseInt(categoryId) : null,
      businessId: null,
      verticalId: null,
      is_meal_manager_entry: false,
    };
    return btoa(JSON.stringify(obj));
  };

  // ─── itemPage query ───────────────────────────────────────────────────────
  // All declared vars must appear in query body — server enforces strict validation.
  // @skip/@include satisfy the "unused variable" requirement for $isNested,
  // $shouldFetchPresetCarousels, and $shouldFetchStoreLiteData.

  const ITEM_PAGE_QUERY = `query itemPage($storeId: ID!, $itemId: ID!, $consumerId: ID, $isMerchantPreview: Boolean, $isNested: Boolean!, $fulfillmentType: FulfillmentType, $shouldFetchPresetCarousels: Boolean!, $cursorContext: ItemPageCursorContextInput, $shouldFetchStoreLiteData: Boolean!, $scheduledMinTimeUtc: String, $scheduledMaxTimeUtc: String) {
  itemPage(
    storeId: $storeId
    itemId: $itemId
    consumerId: $consumerId
    isMerchantPreview: $isMerchantPreview
    fulfillmentType: $fulfillmentType
    cursorContext: $cursorContext
    scheduledMinTimeUtc: $scheduledMinTimeUtc
    scheduledMaxTimeUtc: $scheduledMaxTimeUtc
  ) {
    itemHeader @skip(if: $isNested) {
      id
      name
      description
      menuId
      storeLiteData @include(if: $shouldFetchStoreLiteData) {
        id
        __typename
      }
      __typename
    }
    optionLists {
      id
      name
      isOptional
      minNumOptions
      maxNumOptions
      options {
        id
        name
        unitAmount
        __typename
      }
      __typename
    }
    presetCarousels @include(if: $shouldFetchPresetCarousels) {
      name
      __typename
    }
    itemType @skip(if: $isNested)
    __typename
  }
}`;

  const fetchItemPage = async (item) => {
    const res = await fetch("/graphql/itemPage?operation=itemPage", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        operationName: "itemPage",
        variables: {
          storeId: state.storeId,
          itemId: item.id,
          consumerId: null,
          isMerchantPreview: false,
          isNested: false,
          shouldFetchPresetCarousels: true,
          shouldFetchStoreLiteData: false,
          fulfillmentType: "Delivery",
          cursorContext: { itemCursor: buildCursor(item.id, item.categoryId) },
        },
        query: ITEM_PAGE_QUERY,
      }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    if (json.errors?.length) throw new Error(json.errors[0].message);
    return json.data?.itemPage || null;
  };

  // ─── Data storage ─────────────────────────────────────────────────────────

  const storeItemResult = (item, itemPage) => {
    const modifierGroups = (itemPage?.optionLists || [])
      .map((ol) => ({
        id: ol.id,
        name: ol.name,
        required: !ol.isOptional,
        minSelect: ol.minNumOptions,
        maxSelect: ol.maxNumOptions,
        options: (ol.options || [])
          .map((o) => ({
            id: o.id,
            name: o.name,
            price: o.unitAmount
              ? `$${(o.unitAmount / 100).toFixed(2)}`
              : "$0.00",
          }))
          .filter((o) => o.name),
      }))
      .filter((g) => !isRecommendedModifierGroup(g))
      .filter((g) => g.options.length > 0);

    state.itemDataById[item.id] = {
      itemName: item.name,
      description: item.description,
      price: item.price,
      category: item.category,
      modifierGroups,
    };
    state.collected++;
    updatePanel();
  };

  // ─── rawContent builder ───────────────────────────────────────────────────

  const buildRawContent = () => {
    const storeName =
      state.storeName ||
      document.title.replace(/\s*[-|].*$/, "").trim() ||
      "Menu";
    const lines = [`# ${storeName}`, ""];
    const byCategory = new Map();
    for (const item of state.items) {
      if (!byCategory.has(item.category)) byCategory.set(item.category, []);
      byCategory.get(item.category).push(item);
    }
    for (const [category, catItems] of byCategory) {
      lines.push(`## ${category}`, "");
      const categoryDescription = catItems.find(
        (item) =>
          item.categoryDescription &&
          item.categoryDescription !== item.category,
      )?.categoryDescription;
      if (categoryDescription) {
        lines.push(categoryDescription, "");
      }
      for (const item of catItems) {
        const data = state.itemDataById[item.id];
        if (!data) continue;
        const priceStr = data.price ? ` — ${data.price}` : "";
        lines.push(`${data.itemName}${priceStr}`);
        if (data.description && data.description !== data.itemName)
          lines.push(data.description);
        lines.push("");
      }
    }
    return lines.join("\n").trim();
  };

  // ─── Output payload ───────────────────────────────────────────────────────

  const buildPayload = () => ({
    source: "doordash",
    storeId: state.storeId,
    storeName: state.storeName,
    pageUrl: window.location.href,
    collectedAt: new Date().toISOString(),
    rawContent: buildRawContent(),
    items: state.items
      .map((item) => {
        const data = state.itemDataById[item.id];
        if (!data) return null;
        return {
          itemId: item.id,
          itemName: data.itemName,
          category: data.category,
          categoryDescription: item.categoryDescription || null,
          description: data.description,
          price: data.price,
          modifierGroups: data.modifierGroups,
        };
      })
      .filter(Boolean),
  });

  const postPayloadToMenuMaker = (payload) => {
    if (!MM_SESSION || !window.opener) return;
    try {
      window.opener.postMessage(
        {
          type: BRIDGE_MESSAGE_TYPE,
          sessionId: MM_SESSION,
          payload,
        },
        "*",
      );
    } catch (err) {
      console.warn("[MM Bridge] postMessage failed:", err);
    }
  };

  // ─── Supabase Realtime publish ────────────────────────────────────────────

  const publishToMenuMaker = async () => {
    if (state.published) return;
    state.published = true;
    updateStatus("📡 Sending to Menu Maker…", "collecting");
    try {
      const payload = buildPayload();
      postPayloadToMenuMaker(payload);
      const topic = `realtime:${CHANNEL_PREFIX}:${MM_SESSION}`;
      const res = await fetch(`${SUPABASE_URL}/realtime/v1/api/broadcast`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          apikey: SUPABASE_KEY,
          Authorization: `Bearer ${SUPABASE_KEY}`,
        },
        body: JSON.stringify({
          messages: [{ topic, event: "menu_collected", payload }],
        }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
      updateStatus("✅ Sent! Closing tab…", "done");
      setTimeout(() => window.close(), 1200);
    } catch (err) {
      console.error("[MM Bridge] Publish error:", err);
      if (MM_SESSION && window.opener) {
        updateStatus(
          "Menu Maker was notified directly. Closing tab...",
          "done",
        );
        setTimeout(() => window.close(), 1200);
        return;
      }
      updateStatus(
        `⚠️ Send failed: ${err.message}. Copy JSON manually.`,
        "warn",
      );
      const copyBtn = document.getElementById("mm-copy-btn");
      if (copyBtn) copyBtn.disabled = false;
    }
  };

  // ─── Main collection flow ─────────────────────────────────────────────────

  const collectAll = async () => {
    if (state.isCollecting) return;
    state.isCollecting = true;
    state.collected = 0;
    state.errors = 0;
    state.itemDataById = {};
    state.totalToCollect = state.items.length;
    updateStatus(
      `⚡ Fetching modifiers for ${state.items.length} items…`,
      "collecting",
    );
    updatePanel();

    const CONCURRENCY = 3;
    for (let i = 0; i < state.items.length; i += CONCURRENCY) {
      const batch = state.items.slice(i, i + CONCURRENCY);
      await Promise.all(
        batch.map(async (item) => {
          try {
            const itemPage = await fetchItemPage(item);
            storeItemResult(item, itemPage);
          } catch (e) {
            console.warn(
              `[MM Bridge] Error on item ${item.id} (${item.name}):`,
              e.message,
            );
            storeItemResult(item, null);
            state.errors++;
          }
        }),
      );
      if (i + CONCURRENCY < state.items.length) await sleep(500);
    }

    state.isCollecting = false;
    const withMods = Object.values(state.itemDataById).filter(
      (v) => v.modifierGroups.length > 0,
    ).length;
    const noMods = state.items.length - withMods;
    updateStatus(
      `✅ Done! ${withMods} with modifiers, ${noMods} without${state.errors ? `, ${state.errors} failed` : ""}.`,
      "done",
    );
    updatePanel();

    // Show close button in manual mode; auto-publish in AUTO_MODE
    if (AUTO_MODE) {
      await publishToMenuMaker();
    } else {
      const closeBtn = document.getElementById("mm-close-btn");
      if (closeBtn) closeBtn.style.display = "";
    }
  };

  // ─── Styles ───────────────────────────────────────────────────────────────

  const injectStyles = () => {
    const style = document.createElement("style");
    style.textContent = `
      #mm-collector {
        position: fixed; bottom: 20px; right: 20px; z-index: 999999;
        width: 320px; max-height: 90vh; background: #1a1a2e; color: #e0e0e0;
        font-family: system-ui, sans-serif; font-size: 13px;
        border-radius: 12px; box-shadow: 0 8px 32px rgba(0,0,0,0.5);
        border: 1px solid #333; overflow: hidden; display: flex; flex-direction: column;
      }
      #mm-collector .mm-header {
        background: #16213e; padding: 12px 16px;
        display: flex; align-items: center; justify-content: space-between;
        cursor: move; user-select: none;
      }
      #mm-collector .mm-title   { font-weight: 700; font-size: 14px; color: #fff; }
      #mm-collector .mm-badge   { background: #e53935; color: white; font-size: 10px; padding: 2px 7px; border-radius: 10px; font-weight: 600; }
      #mm-collector .mm-body    { padding: 14px 16px; overflow-y: auto; }
      #mm-collector .mm-status  { padding: 8px 10px; border-radius: 8px; margin-bottom: 12px; background: #0f3460; font-size: 12px; line-height: 1.4; }
      #mm-collector .mm-status.ready      { background: #1b5e20; }
      #mm-collector .mm-status.warn       { background: #e65100; }
      #mm-collector .mm-status.collecting { background: #0d47a1; }
      #mm-collector .mm-status.done       { background: #1b5e20; }
      #mm-collector .mm-stats   { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-bottom: 12px; }
      #mm-collector .mm-stat    { background: #0f3460; border-radius: 8px; padding: 8px 10px; text-align: center; }
      #mm-collector .mm-stat-val { font-size: 20px; font-weight: 700; color: #fff; }
      #mm-collector .mm-stat-lbl { font-size: 10px; color: #aaa; margin-top: 2px; }
      #mm-collector .mm-progress { height: 4px; background: #333; border-radius: 2px; margin-bottom: 12px; }
      #mm-collector .mm-progress-bar { height: 100%; background: #2196f3; border-radius: 2px; transition: width 0.3s; }
      #mm-collector .mm-btn     { width: 100%; padding: 10px; border: none; border-radius: 8px; font-size: 13px; font-weight: 600; cursor: pointer; margin-bottom: 6px; transition: opacity 0.2s; }
      #mm-collector .mm-btn:hover:not(:disabled) { opacity: 0.85; }
      #mm-collector .mm-btn:disabled { opacity: 0.4; cursor: not-allowed; }
      #mm-collector .mm-btn-primary   { background: #2196f3; color: white; }
      #mm-collector .mm-btn-secondary { background: #333; color: #eee; }
      #mm-collector .mm-btn-success   { background: #2e7d32; color: white; }
      #mm-collector .mm-items-preview { max-height: 140px; overflow-y: auto; background: #111; border-radius: 8px; padding: 8px 10px; margin-bottom: 10px; font-size: 11px; line-height: 1.8; }
      #mm-collector .mm-item-row  { display: flex; justify-content: space-between; }
      #mm-collector .mm-item-name { color: #ddd; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 220px; }
      #mm-collector .mm-item-mods { color: #64b5f6; flex-shrink: 0; margin-left: 6px; }
      #mm-collector .mm-item-none { color: #555; flex-shrink: 0; margin-left: 6px; }
      #mm-collector .mm-mm-banner {
        display: flex; align-items: center; gap: 7px;
        background: #0d2a0d; border: 1px solid #2e7d32;
        color: #81c784; font-size: 11px; font-weight: 600;
        padding: 6px 10px; border-radius: 7px; margin-bottom: 10px;
      }
      #mm-collector .mm-mm-dot {
        width: 7px; height: 7px; border-radius: 50%;
        background: #43a047; flex-shrink: 0;
        box-shadow: 0 0 6px #43a047;
        animation: mm-pulse 1.8s ease-in-out infinite;
      }
      @keyframes mm-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }
    `;
    document.head.appendChild(style);
  };

  // ─── Panel ────────────────────────────────────────────────────────────────

  const injectPanel = () => {
    if (document.getElementById("mm-collector")) return;
    injectStyles();

    const panel = document.createElement("div");
    panel.id = "mm-collector";
    const mmBanner = AUTO_MODE
      ? `<div class="mm-mm-banner"><span class="mm-mm-dot"></span>Connected to Menu Maker</div>`
      : "";

    panel.innerHTML = `
      <div class="mm-header">
        <span class="mm-title">🍽 Menu Maker Bridge</span>
        <span class="mm-badge">PopMenu</span>
      </div>
      <div class="mm-body">
        ${mmBanner}
        <div class="mm-status" id="mm-status">
          ${AUTO_MODE ? "⚡ Collecting…" : "⏳ Ready — click Collect to start."}
        </div>
        <div class="mm-stats">
          <div class="mm-stat">
            <div class="mm-stat-val" id="mm-ids-count">—</div>
            <div class="mm-stat-lbl">Items Found</div>
          </div>
          <div class="mm-stat">
            <div class="mm-stat-val" id="mm-mods-count">—</div>
            <div class="mm-stat-lbl">With Modifiers</div>
          </div>
        </div>
        <div class="mm-progress"><div class="mm-progress-bar" id="mm-progress-bar" style="width:0%"></div></div>
        <div class="mm-items-preview" id="mm-items-preview"><em style="color:#555">Nothing collected yet</em></div>
        <button class="mm-btn mm-btn-primary" id="mm-collect-btn" style="display:none">⚡ Collect All Modifiers</button>
        <button class="mm-btn mm-btn-success"   id="mm-copy-btn" disabled>📋 Copy JSON</button>
        <button class="mm-btn mm-btn-success" id="mm-close-btn" style="display:none;background:#1565c0">✅ Close Tab</button>
        <button class="mm-btn mm-btn-secondary" id="mm-clear-btn">🗑 Clear</button>
      </div>
    `;
    document.body.appendChild(panel);

    document.getElementById("mm-collect-btn").onclick = () => {
      if (!state.isCollecting) collectAll();
    };
    document.getElementById("mm-copy-btn").onclick = () => {
      navigator.clipboard
        .writeText(JSON.stringify(buildPayload(), null, 2))
        .then(() => updateStatus("✅ Copied! Paste into Menu Maker.", "done"));
    };
    document.getElementById("mm-close-btn").onclick = () => window.close();
    document.getElementById("mm-clear-btn").onclick = () => {
      Object.assign(state, {
        itemDataById: {},
        isCollecting: false,
        totalToCollect: 0,
        collected: 0,
        errors: 0,
        published: false,
      });
      updateStatus("🗑 Cleared.", "");
      updatePanel();
    };
    makeDraggable(panel, panel.querySelector(".mm-header"));
  };

  const updateStatus = (msg, type = "") => {
    const el = document.getElementById("mm-status");
    if (el) {
      el.textContent = msg;
      el.className = "mm-status" + (type ? ` ${type}` : "");
    }
  };

  const updatePanel = () => {
    const entries = Object.entries(state.itemDataById);
    const withMods = entries.filter(
      ([, v]) => v.modifierGroups.length > 0,
    ).length;
    const idsEl = document.getElementById("mm-ids-count");
    const modsEl = document.getElementById("mm-mods-count");
    if (idsEl) idsEl.textContent = state.items.length || "—";
    if (modsEl) modsEl.textContent = entries.length ? withMods : "—";
    const pct =
      state.totalToCollect > 0
        ? Math.round((state.collected / state.totalToCollect) * 100)
        : 0;
    const bar = document.getElementById("mm-progress-bar");
    if (bar) bar.style.width = pct + "%";
    const collectBtn = document.getElementById("mm-collect-btn");
    if (collectBtn) {
      collectBtn.disabled = state.isCollecting;
      collectBtn.textContent = state.isCollecting
        ? `⏳ Collecting… ${state.collected}/${state.totalToCollect}`
        : "⚡ Collect All Modifiers";
    }
    const copyBtn = document.getElementById("mm-copy-btn");
    if (copyBtn) copyBtn.disabled = entries.length === 0 || state.isCollecting;
    const preview = document.getElementById("mm-items-preview");
    if (preview) {
      if (!entries.length) {
        preview.innerHTML = '<em style="color:#555">Nothing collected yet</em>';
      } else {
        preview.innerHTML = entries
          .map(
            ([, v]) => `
          <div class="mm-item-row">
            <span class="mm-item-name">${v.itemName}</span>
            <span class="${v.modifierGroups.length ? "mm-item-mods" : "mm-item-none"}">
              ${v.modifierGroups.length ? `${v.modifierGroups.length} mod${v.modifierGroups.length !== 1 ? "s" : ""}` : "no mods"}
            </span>
          </div>`,
          )
          .join("");
        preview.scrollTop = preview.scrollHeight;
      }
    }
  };

  const makeDraggable = (el, handle) => {
    let mx = 0,
      my = 0;
    handle.onmousedown = (e) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      el.style.left = rect.left + "px";
      el.style.top = rect.top + "px";
      el.style.right = "auto";
      el.style.bottom = "auto";
      mx = e.clientX;
      my = e.clientY;
      document.onmousemove = (ev) => {
        const dx = ev.clientX - mx;
        const dy = ev.clientY - my;
        mx = ev.clientX;
        my = ev.clientY;
        el.style.left = el.offsetLeft + dx + "px";
        el.style.top = el.offsetTop + dy + "px";
      };
      document.onmouseup = () => {
        document.onmousemove = null;
        document.onmouseup = null;
      };
    };
  };

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // ─── Boot ─────────────────────────────────────────────────────────────────

  waitForApollo(() => {
    injectPanel();
    updateStatus("⏳ Waiting for menu data…", "");

    waitForFeed((feedKey, feed) => {
      if (!feed || !feedKey) {
        updateStatus(
          "⚠️ No menu data found. Are you on a DoorDash store page?",
          "warn",
        );
        return;
      }

      const { storeId, menuId } = parseIds(feedKey);
      state.storeId = storeId;
      state.menuId = menuId;

      const cache = window.__APOLLO_CLIENT__.cache.data.data;
      const storeHeader = cache[`StoreHeader:${storeId}`];
      state.storeName = storeHeader?.name || null;

      state.items = extractItems(feed);

      if (!state.items.length) {
        updateStatus("⚠️ No items found in menu feed.", "warn");
        return;
      }

      updatePanel();

      collectAll(); // auto-start always
    });
  });
})();
