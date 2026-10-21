# Development image for the Python GIS AI / RAG service (docker-compose).
FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    HF_HOME=/opt/models \
    FASTEMBED_CACHE_PATH=/opt/models/fastembed

WORKDIR /app

# No apt-get: the base image already has ca-certificates, and the health
# check below uses Python instead of curl — so the build never depends on
# reaching deb.debian.org (blocked/proxied on some office networks).

COPY requirements.txt ./
RUN pip install -r requirements.txt

# Pre-download the local embedding model so first request is fast and the
# container works without internet at runtime.
RUN python -c "from fastembed import TextEmbedding; TextEmbedding('BAAI/bge-small-en-v1.5')"

COPY app ./app

EXPOSE 8000

HEALTHCHECK --interval=15s --timeout=5s --start-period=40s --retries=5 \
    CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://localhost:8000/health', timeout=4).status == 200 else 1)" || exit 1

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
