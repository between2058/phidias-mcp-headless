# phidias-mcp-headless

Phidias 資產生成 pipeline 的 **headless** MCP server —— 給 Claude Code（或任何 MCP client）用來文字生圖、圖生 3D、3D 模型分割。

**不需要 Phidias 前端**。純後端 pipeline，所有工具輸出都是本機檔案路徑。

---

## 功能

| 工具 | 說明 |
|---|---|
| `generate_image` | 用 Qwen 從 prompt 生參考圖（PNG） |
| `generate_3d` | 從參考圖生 3D 模型（GLB），支援 `trellis2` 高品質 / `reconviagen` 快速 |
| `segment_model` | 用 P3-SAM 把 GLB 切成語意部件 |
| `inspect_model` | 讀 GLB 結構（node、bbox、centroid、face count） |
| `merge_parts` | 把多個 node 幾何融合成單一 mesh |
| `apply_part_names` | 重新命名 / 重新編組 GLB 節點 |
| `export_articulation` | 從 GLB + parts/joints 描述產出 USDZ + phidias.physics.v1 JSON |
| `download_asset` / `list_generated_assets` | Session 資產管理 |

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
| `ARTICULATION_API_URL` | `http://172.18.245.177:52071` | 產出 USDZ/USDA 的 articulation-service |

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

## HTTP 模式（讓其他電腦的 Claude Code 連過來）

預設是 stdio mode（由 Claude Code spawn）。如果你想把這台機器當 MCP server、讓**其他電腦**的 Claude Code 連過來用，設 `MCP_HTTP_PORT` 就切到 HTTP 模式：

```bash
MCP_HTTP_PORT=7777 MCP_HTTP_TOKEN=your-secret node dist/index.js
```

啟動後會看到：
```
[phidias-mcp] HTTP mode listening on http://0.0.0.0:7777/mcp (auth: Bearer token required)
```

其他電腦的 Claude Code config：
```json
{
  "mcpServers": {
    "phidias": {
      "type": "http",
      "url": "http://<你的主機>:7777/mcp",
      "headers": {
        "Authorization": "Bearer your-secret"
      }
    }
  }
}
```

**HTTP 模式相關 env**：

| 變數 | 預設值 | 說明 |
|---|---|---|
| `MCP_HTTP_PORT` | （未設 → stdio） | 設了就切 HTTP mode |
| `MCP_HTTP_HOST` | `0.0.0.0` | 綁的介面。要只讓自己用就設 `127.0.0.1` |
| `MCP_HTTP_TOKEN` | （未設 → 無認證）| Bearer token；綁 `0.0.0.0` 時**強烈建議**設 |

健康檢查端點：`GET http://host:port/health` → `{"status":"ok"}`。

⚠️ 綁 `0.0.0.0` 而沒設 `MCP_HTTP_TOKEN`，任何同網路的人都能呼叫你的後端 API。啟動時 log 會警告。

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
