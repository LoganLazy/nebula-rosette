# Nebula Rosette —— 后端 + 前端静态文件，一个镜像跑完。
#
# 前端由 FastAPI 挂在同源根路径下（见 server/main.py 的 FRONTEND_DIR），
# 所以不需要第二个 web 容器，也没有跨域问题。
#
# 构建：docker build -t nebula-rosette .
# 运行：见 docker-compose.yml（推荐）或 README 的部署一节

FROM python:3.12-slim

# PYTHONDONTWRITEBYTECODE：容器是一次性的，.pyc 只会让镜像层变脏
# PYTHONUNBUFFERED：不缓冲 stdout，否则 docker logs 看不到实时日志
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /app

# 依赖单独一层：只要 requirements.txt 没变，改代码不会触发重新装包
COPY server/requirements.txt /app/server/requirements.txt
RUN pip install --no-cache-dir -r /app/server/requirements.txt

# 前端静态文件。main.py 里 FRONTEND_DIR = 父目录，
# 所以这几项的相对位置必须和仓库一致，不能拍平。
COPY index.html manifest.webmanifest sw.js /app/
COPY js/ /app/js/
COPY assets/ /app/assets/
COPY server/ /app/server/

# 数据目录。SQLite 库和 .enc_key 都放这儿，挂成 volume 才能在
# 重建容器后保住数据——这两个文件缺一个，库里存的 API Key 就解不开了。
RUN mkdir -p /data
ENV DB_PATH=/data/nebula.db \
    ENC_KEY_FILE=/data/.enc_key

# 非 root 运行。这个服务会接公网请求，没有任何理由用 root。
# /data 要提前 chown，否则首次启动建库会 Permission denied。
RUN useradd --create-home --uid 10001 rosette \
    && chown -R rosette:rosette /app /data
USER rosette

WORKDIR /app/server

EXPOSE 8000

# 健康检查打 /api/health —— 它不碰数据库以外的东西，也不需要登录
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8000/api/health', timeout=4).status == 200 else 1)"

# 单 worker：SQLite 在多进程写入下会撞锁，而这个应用的写入量
# （一个人一天记几条）离需要多 worker 差着好几个数量级。
# 真要横向扩容，先把存储换成 Postgres，而不是加 worker。
#
# 代理头只信回环地址：uvicorn 默认 forwarded_allow_ips 就是 127.0.0.1，
# 宿主机上的 nginx 从回环连进来，正好覆盖文档里的两种部署。
# 千万别加 --forwarded-allow-ips "*"——那会让任意来源的
# X-Forwarded-For 都被采信，一旦有人把容器端口公开映射出去，
# 任何人伪造这个头就能绕过登录限流（main.py 的 TRUST_PROXY 拦不住，
# 因为 uvicorn 在应用看到请求之前就已经按这个头改写了 client.host）。
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "1", "--proxy-headers"]
