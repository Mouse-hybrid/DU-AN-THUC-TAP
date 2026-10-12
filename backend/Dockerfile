FROM python:3.11-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /app
RUN addgroup --system app && adduser --system --ingroup app app
COPY requirements.txt ./
RUN pip install --no-cache-dir --requirement requirements.txt
COPY alembic.ini ./
COPY migrations ./migrations
COPY scripts ./scripts
COPY app ./app
# Commit/thời điểm build cho GET /version (deploy-staging.sh và CI truyền vào).
ARG GIT_COMMIT=unknown
ARG BUILT_AT=unknown
ENV GIT_COMMIT=${GIT_COMMIT} \
    BUILT_AT=${BUILT_AT}
USER app
EXPOSE 8000
CMD ["python", "-m", "uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
