> **只给自己用、不打算从外网访问？** 那不需要这个文件，直接开
> `dist/nebula-rosette.html` 或本机跑 `uvicorn` 就够了。

两种部署方式，选一个。都需要在前面挂一层带 TLS 的反代
（见 `nginx.conf.example`）——不挂 TLS 的话，密码和会话 token 是明文传输，
谁在同一个网络里都能看到。

## 方式一：systemd（裸机，推荐单人自用）

不需要 Docker。改代码即时生效，少一层抽象。

```sh
# 1. 建一个不能登录的专用账号
sudo useradd --system --home /srv/nebula-rosette --shell /usr/sbin/nologin rosette

# 2. 放好代码并装依赖
sudo cp -r . /srv/nebula-rosette
cd /srv/nebula-rosette
sudo pip install -r server/requirements.txt
sudo cp server/.env.example .env      # 改 ALLOWED_ORIGINS
sudo chown -R rosette:rosette /srv/nebula-rosette

# 3. 装 unit
which uvicorn                          # 记下路径，填进 unit 的 ExecStart
sudo cp deploy/nebula-rosette.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now nebula-rosette
systemctl status nebula-rosette
```

装之前必须改 unit 里的三处：`User`/`Group`、`WorkingDirectory`（要指到
`server/` 目录，因为 `main.py` 用 `import auth` 这样的同级导入）、
以及 `ExecStart` 的 uvicorn 绝对路径（systemd 不走 shell，不认 PATH）。

日志：`journalctl -u nebula-rosette -f`。改完代码：`sudo systemctl restart nebula-rosette`。

## 方式二：Docker

```sh
cp server/.env.example .env      # 至少填 ALLOWED_ORIGINS，其余可留空
docker compose up -d
docker compose logs -f           # 看到 Uvicorn running 就好了
```

数据在 `nebula-data` 这个 volume 里，`docker compose down` 不会删，
`down -v` 会。

## 两种方式都要注意的

`.env` 里两个必须改的：

- `ALLOWED_ORIGINS` 换成你的真实域名（`https://rosette.example.com`），
  留着 localhost 的话浏览器会拦跨域请求。
- `ALLOW_REGISTRATION=1` 先保持开着，注册完自己的账号后改成 `0` 再重启一次
  ——否则任何知道地址的人都能注册。

`TRUST_PROXY` 的取值取决于前面有没有反代：Docker 的 compose 里已设成 1
（容器前面必然有一层）；systemd unit 里显式写的是 0，挂了反代要改成 1。
设错的后果不对称——挂了反代却设 0 只是限流失效，而直接暴露公网却设 1
等于让任何人伪造 `X-Forwarded-For` 绕过登录限流。

备份用 `sh backup.sh`，它两种部署都认（检测不到容器就走裸机分支）。
挂到 cron 上：

```sh
20 3 * * * cd /srv/nebula-rosette && sh deploy/backup.sh >> /var/log/rosette-backup.log 2>&1
```
