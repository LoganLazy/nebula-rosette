# 上传前的最后一遍检查

对着走一遍，五分钟。做完就能推。

## 1. 保留本地数据，检查不会提交

不要为了发布源码删除本地数据库或加密密钥。先按备份说明保管数据，再检查忽略规则：

```sh
git check-ignore server/nebula.db server/.enc_key .env server/.env
git diff --cached --name-only
```

待提交列表不能包含数据库、密钥、真实配置、个人导出及旧发布压缩包。
一旦敏感数据进入公开 Git 历史，普通删除不能清除旧提交，需要单独处理历史并更换凭据。

## 2. 替换占位符

`deploy/nebula-rosette.service` 第 20 行：

```ini
Documentation=https://github.com/your-name/nebula-rosette
```

本项目地址已设为 `https://github.com/LoganLazy/nebula-rosette`。`deploy/nginx.conf.example` 里的
`rosette.example.com` **不用改**——那是给使用者照着改的示例。

## 3. 初始化并推送

```sh
git init
git add .
git status                    # 停下来，逐行看一遍下面这几项
```

`git status` 里**不应该出现**：

- 任何 `.db` / `.db-wal` / `.db-shm`
- `.env`（`server/.env.example` 应该出现，那是模板，没有真实值）
- 任何 `.enc_key`
- `__pycache__/`、`node_modules/`
- `nebula-rosette-*.json`（那是你导出的个人备份）

文件数量随版本变化，其中应包括 `dist/nebula-rosette.html`（这份是给使用者
双击就能用的，刻意提交）。

确认干净之后：

```sh
git commit -m "Nebula Rosette: local-first 生理期日历"
git branch -M main
git remote add origin git@github.com:你的用户名/nebula-rosette.git
git push -u origin main
```

## 4. 仓库设置

- **Description** 建议写清 local-first 这个特点，它是这个项目区别于其他生理期
  应用的核心：`本地优先的生理期日历，数据默认只存在浏览器里，可自托管同步`
- **Topics**：`period-tracker` `menstrual-cycle` `local-first` `pwa`
  `self-hosted` `fastapi` `vanilla-js`
- Issues 打开，Wiki 和 Projects 可以关掉
- **不要** 开 GitHub Pages 指向仓库根目录——那会把 `index.html` 挂出去，
  但没有后端，登录和 AI 全是坏的，反而让人以为项目有问题。
  真要做线上 demo，单独部署 `dist/nebula-rosette.html`。

## 5. 推完之后

- 去 Actions 标签确认 CI 三个 job 全绿（`tests.yml` 会跑 512 项测试、
  校验 `dist/` 与源文件一致、检查敏感文件确实被 ignore）
- 如果 CI 报 `dist/ 与源文件不一致`，说明你本地改过前端但没重新打包：
  `node build/build.js` 之后再提交一次

## 关于「上市」

这个项目适合开源发布，不适合作为商业服务对外运营。生理周期数据在
《个人信息保护法》第 28 条里属于敏感个人信息，GDPR 归为特殊类别数据（Art. 9），
替他人保管需要隐私政策、用户协议、单独同意流程和备案主体。

而它现在的价值恰恰在于**不替任何人保管数据**：使用者自己部署一份，
数据在自己手里。README 里已经写明这不是医疗设备。
