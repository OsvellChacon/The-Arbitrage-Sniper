FROM python:3.11-slim

WORKDIR /app

RUN apt-get update && apt-get install -y \
    build-essential \
    libzmq3-dev \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt* ./

RUN pip install --no-cache-dir \
    pyzmq \
    redis \
    || true

RUN pip install --no-cache-dir -r requirements.txt || true

COPY . .

CMD ["python", "pull_zmq.py"]
