from fastapi import FastAPI

from app.api.tasks import router as tasks_router
from app.db.database import Base, engine
import app.models.task

Base.metadata.create_all(bind=engine)

app = FastAPI(title="Task Management API")
app.include_router(tasks_router)


@app.get("/")
def read_root():
    return {"message": "Task Management API is running"}


@app.get("/health")
def health_check():
    return {"status": "ok"}
