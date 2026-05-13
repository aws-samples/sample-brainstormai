FROM python:3.12-slim

WORKDIR /app

# Apply OS security patches; libmupdf-dev is not needed — PyMuPDF>=1.24 ships bundled MuPDF wheels
RUN apt-get update && apt-get upgrade -y && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

RUN useradd --no-create-home --shell /bin/false appuser
USER appuser

CMD ["python", "main.py"]
