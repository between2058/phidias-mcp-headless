# phidias-mcp-headless

Phidias 資產生成 pipeline 的 **headless** MCP server —— 給 Claude Code（或任何 MCP client）用來文字生圖、圖生 3D、3D 模型分割。

**不需要 Phidias 前端**。純後端 pipeline，所有工具輸出都是本機檔案路徑。

---

## 功能

| 工具 | 說明 |
|---|---|
| `generate_image` | 用 Qwen 從 prompt 生參考圖（PNG） |
| `generate_3d` | 從參考圖生 3D 模型（GLB），支援 `trellis2` 高品質 / `reconviagen` 快速 |
| `segment_model` | 用 P3-SAM 把 GLB 切成語意部件（頭、身體、腿……） |
| `list_generated_assets` | 列出當次 session 生成的所有檔案 |

---

## 前提條件

- Node.js 18+
- pnpm
- 同網路能連到 Phidias 內部 API（預設走 `172.18.245.177`）

---

## 安裝

```bash
git clone <this-repo-url> phidias-mcp
cd phidias-mcp
pnpm install
pnpm build
```

這會產出 `dist/index.js`。

---

## 接到 Claude Code

編輯你的 `~/.claude.json`（或 `~/.config/claude-code/claude_desktop_config.json`，依 Claude Code 版本），在 `mcpServers` 區塊加入：

```json
{
  "mcpServers": {
    "phidias": {
      "command": "node",
      "args": ["/絕對路徑/phidias-mcp/dist/index.js"]
    }
  }
}
```

重啟 Claude Code，輸入 `/mcp` 應該會看到 `phidias` 跟 4 個工具。

---

## 環境變數

如果你的後端 API 不在預設內網位址，覆寫下列 env：

| 變數 | 預設值 | 說明 |
|---|---|---|
| `QWEN_API_URL` | `http://172.18.245.177:8190` | 文字生圖 |
| `TRELLIS2_API_URL` | `http://172.18.245.177:52070` | 3D（高品質） |
| `RECONVIAGEN_API_URL` | `http://172.18.245.177:52069` | 3D（快速） |
| `P3SAM_API_URL` | `http://172.18.245.177:5001` | 分割 |

在 Claude Code config 中加 `env` 欄位：

```json
{
  "mcpServers": {
    "phidias": {
      "command": "node",
      "args": ["/絕對路徑/phidias-mcp/dist/index.js"],
      "env": {
        "QWEN_API_URL": "http://your-host:8190",
        "TRELLIS2_API_URL": "http://your-host:52070"
      }
    }
  }
}
```

---

## 使用範例

在 Claude Code 裡直接說：

- 「幫我生成一張太空人的參考圖」
- 「把這張圖變成 3D 模型，用 reconviagen」
- 「把這個 GLB 分割成部件：/path/to/model.glb」
- 「列出目前 session 生成的檔案」

輸出檔案會放在系統暫存目錄（macOS 通常是 `/var/folders/.../phidias-mcp/`），路徑會在工具回應裡告訴你。

---

## 疑難排解

**「Error generating image/3D/segment: fetch failed」**
→ 後端 API 連不到。確認同網路、或設對應的 `*_API_URL` env。

**「Cannot find module 'dist/index.js'」**
→ 忘了 `pnpm build`。

**Claude Code 看不到 `phidias` server**
→ 檢查 `~/.claude.json` 路徑是不是絕對路徑、JSON 有沒有打錯；重啟 Claude Code。

---

## 與 Phidias 前端的關係

這是 `phidias-standalone/mcp-server/` 的 headless 子集。完整版本還有 `load_model`、`get_viewport_state`、`capture_screenshot`、`smart_organize`，它們需要 Phidias 前端（localhost:3000）一起跑。如果你的工作流程需要 live viewport 互動，去用完整版。
