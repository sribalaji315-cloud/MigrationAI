FROM python:3.11-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY app.py .
# Model artifacts are gitignored and retrained out-of-band, so they are mounted
# rather than baked into the image.
ENV PYTHONUNBUFFERED=1 \
    ML_MODEL_DIR=/models \
    ML_TRAINING_DATA_PATH=/data/training_data_template.csv
EXPOSE 8000
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8000"]
