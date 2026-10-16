# 后续维护说明

这个项目是独立的静态网站，不依赖 ChatGPT 账号。以后可以使用任何代码编辑器或其他 AI 工具继续开发。

- 代码仓库：https://github.com/eve010101/for-inspiration
- 正式分支：`main`。这台电脑上的本地分支名是 `master`，它跟踪远程 `main`。
- 在线网站：https://for-inspiration.pages.dev/
- 托管平台：Cloudflare Pages，项目名 `for-inspiration`。

请保留 GitHub 和 Cloudflare 账号的登录方式与恢复方式。代码仓库不保存账号密码、部署授权或 ChatGPT 聊天记录。

## 获取并运行项目

```sh
git clone https://github.com/eve010101/for-inspiration.git
cd for-inspiration
python -m http.server 4417
```

浏览器打开 `http://127.0.0.1:4417/`。请通过本地服务器访问，因为页面需要读取 JSON，不能只双击 HTML 文件。

现有网站运行不需要安装 Node.js、Python 扩展库或数据库；上面的 Python 仅用于提供本地服务器，也可换用编辑器的静态服务器。

## 文件用途

| 文件 | 用途 |
| --- | --- |
| `index.html` | 页面结构、文案及资源版本号 |
| `app.js` | 随机选书、首页邮票、阅读与加载逻辑 |
| `styles.css`、`reader-overrides.css`、`system-fonts.css` | 外观、移动端布局、字体回退 |
| `data/quotes.json` | 当前全部入选摘录，包含作者、书名、章节 |
| `assets/stamps/` | 1024 × 1536 PNG 阅读原图 |
| `assets/previews/` | 512 × 768 WebP 首页预览图 |
| `assets/stamp-paper*.png`、`assets/stamp-mask.png` | 生成邮票所需的纸张原始素材与模板 |
| `assets/stamp-clean.svg`、`assets/stamp-template.svg` | 矢量素材及模板 |
| `_headers` | Cloudflare 缓存规则 |
| `make_stamp_set.py`、`make_previews.py` | 生成阅读图与首页预览图 |
| `import_quotes.py` | 从 Excel 导入入选摘录 |
| `requirements.txt` | 内容生成工具的 Python 依赖 |
| `tests/`、`package.json`、`package-lock.json` | 可选浏览器回归与性能检查工具 |

## 修改外观或交互

修改 HTML、CSS、JS 后，先在本地服务器检查桌面和手机尺寸的页面。无需编译或打包。

## 修改摘录或增加新邮票

1. 安装 Python 依赖：`python -m pip install -r requirements.txt`。
2. 修改 `data/quotes.json`；`id` 按数组顺序从 1 连续编号。也可执行 `python import_quotes.py "自己的工作簿.xlsx"`，工作簿首行必须包含 `书名（版本）`、`作者`、`句子`、`章节`、`是否入选`，只导入 `是否入选` 等于 `是` 的行。
3. 执行 `python make_stamp_set.py` 生成全部原图，或者执行 `python make_stamp_set.py 1 2` 只生成指定编号。
4. 执行 `python make_previews.py` 生成全部预览，或者执行 `python make_previews.py 1 2` 只生成指定编号。数量依据 JSON，支持增加摘录。
5. 执行 `python verify_project.py` 检查内容和图片是否齐全，再在浏览器验证排版。

修改 JSON 不会自动更新图片中的文字，必须重新生成对应原图和预览图。长句或长书名应人工检查是否超出纸张范围。

默认生成字体是 Windows 自带的仿宋、宋体和 Consolas。其他系统可通过 `--quote-font`、`--detail-font`、`--mono-font` 指定实际字体文件；中文字体应覆盖摘录中的字符。字体变化会影响排版，现有 232 张成品图片无需这些字体也可直接展示。

例如：

```sh
python make_stamp_set.py 1 --quote-font "/path/to/chinese-font.ttf" --detail-font "/path/to/chinese-font.ttf" --mono-font "/path/to/mono-font.ttf"
```

桌面上的原始工作簿没有上传到公开仓库；当前全部入选内容已保存到 `data/quotes.json`，可以直接编辑这些内容。未入选摘录仅存在于原始工作簿中，如需保留应单独备份该工作簿。

`make_stamp_assets.py` 可从已保存的 `assets/stamp-paper.png` 重建模板。`make_stamp_demo.py` 用于早期单张演示。`clean_stamp_svg.py` 需要传入待清理的新 SVG；当前清理好的 SVG 已在仓库中，无需重跑。

## 发布更新

先更新 `app.js` 中的 `BUILD_VERSION` 和 `index.html` 中 CSS/JS 的 `?v=` 版本号。尤其修改同名图片时，必须更新版本号以绕过旧缓存。

```sh
git add <本次修改的文件>
git commit -m "Describe the update"
git push origin HEAD:main
```

GitHub 保存代码；Cloudflare 保存实际发布的网站。推送后是否自动发布，取决于 Cloudflare 项目当前是否连接了 GitHub，不能仅凭推送成功判断网站已更新。

如需手动发布，安装 Node.js 并在自己的 Cloudflare 账号下登录：

```sh
npx wrangler login
npx wrangler pages deploy . --project-name for-inspiration --branch main
```

Cloudflare Pages 无需构建命令；发布目录是项目根目录。项目已有 `_headers` 缓存规则。发布前确认目录内没有私人资料或凭据，发布后打开正式网站检查版本和阅读行为。

## 可选浏览器验证

```sh
npm ci
npx playwright install chromium
```

保持本地服务器在 4417 端口运行，再执行：

```sh
npm run test:desktop
npm run test:touch
npm run test:cache
```

可用 `PREVIEW_ORIGIN` 环境变量指定另一个待测网址；用 `CHROME_PATH` 指定浏览器路径。Windows 默认优先使用标准安装路径下的 Chrome，其他情况下使用 Playwright 的 Chromium。

慢网验证使用 `npm run test:slow`；`PERF_PROFILE=mbps1` 或 `kbps512` 选择档位。慢网测试需要等待原图下载完成，耗时较长。

## 2026-10-16 完整性核对

核对时正式代码、116 条摘录、116 张阅读原图与 116 张预览图均在 GitHub 的 `main` 分支中。纸张生成素材曾在历史提交中被删除，本次恢复了脚本依赖的原始图片，并补上预览生成工具、依赖说明与浏览器检查工具。

本机 `performance-preview/` 是早期性能测试目录，主体与正式版仅资源版本号不同；其中独有的检查脚本已整理到 `tests/`。根目录 `_load_waterfall.cjs` 的检查代码已保存到 `tests/load-waterfall.cjs`。这两个本机调试入口不参与正式网站运行。
