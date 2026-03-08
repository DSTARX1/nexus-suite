FROM python:3.12-slim AS base

RUN groupadd -r mluser && useradd -r -g mluser -d /app -s /sbin/nologin mluser

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

RUN chown -R mluser:mluser /app && mkdir -p /models && chown mluser:mluser /models

USER mluser

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["python", "-c", "import urllib.request; urllib.request.urlopen('http://localhost:8000/health')"]

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
