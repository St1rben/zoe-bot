FROM python:3.11-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /app

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY zoe_bot ./zoe_bot
COPY bot.py ./

RUN useradd --create-home botuser
USER botuser

EXPOSE 8080
CMD ["python", "bot.py"]
