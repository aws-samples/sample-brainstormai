FROM python:3.12-slim

WORKDIR /app

# No system-level C libraries required — all dependencies are pure Python or
# bundled in the boto3 wheel.
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

CMD ["python", "main.py"]
