from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field
from typing import Optional, List, Dict, Any, Tuple
import torch
import numpy as np
from datetime import datetime
import logging
from transformers.model import (
    DemandForecastTransformer,
    TrafficForecastTransformer,
    PriceForecastTransformer,
    TransformerTrainer
)

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/transformer", tags=["Time Series Transformers"])

# Initialize models
demand_model = DemandForecastTransformer()
traffic_model = TrafficForecastTransformer()
price_model = PriceForecastTransformer()

demand_trainer = TransformerTrainer(demand_model)
traffic_trainer = TransformerTrainer(traffic_model)
price_trainer = TransformerTrainer(price_model)

MIN_TRAIN_SAMPLES = 100
SYNTHETIC_DATA_SOURCES = {"synthetic", "random", "noise", "simulated", "randn"}


def _validate_training_dataset(
    data_source: str,
    data: List[List[List[float]]],
    labels: List[List[float]],
    seq_len: int,
    input_dim: int,
    pred_len: int,
    min_samples: int = MIN_TRAIN_SAMPLES,
) -> Tuple[torch.Tensor, torch.Tensor]:
    """Return validated training tensors or fail loudly on synthetic/noisy input.

    The training endpoints share the exact model objects served by the
    forecast endpoints, so fitting on random noise or an empty dataset would
    silently destroy forecast quality. Training is gated on a real, validated
    data source with a minimum number of rows; anything else is rejected.
    """
    if not data_source or data_source.strip().lower() in SYNTHETIC_DATA_SOURCES:
        raise HTTPException(
            status_code=422,
            detail="Refusing to train: data_source must be a real, validated "
                   "source (synthetic/random noise is rejected). Production "
                   "model weights are never fit on noise.",
        )
    if not data or not labels:
        raise HTTPException(
            status_code=422,
            detail="Refusing to train: empty training dataset supplied.",
        )
    if len(data) < min_samples:
        raise HTTPException(
            status_code=422,
            detail=f"Refusing to train: {len(data)} rows supplied; at least "
                   f"{min_samples} rows of real data are required.",
        )
    x = torch.tensor(data, dtype=torch.float32)
    y = torch.tensor(labels, dtype=torch.float32)
    if x.ndim != 3 or x.shape[1:] != (seq_len, input_dim):
        raise HTTPException(
            status_code=422,
            detail=f"Refusing to train: train_data must have shape "
                   f"(n, {seq_len}, {input_dim}).",
        )
    if y.ndim != 2 or y.shape[1] != pred_len:
        raise HTTPException(
            status_code=422,
            detail=f"Refusing to train: train_labels must have shape (n, {pred_len}).",
        )
    if len(x) != len(y):
        raise HTTPException(
            status_code=422,
            detail="Refusing to train: train_labels row count does not match train_data.",
        )
    if not torch.isfinite(x).all() or not torch.isfinite(y).all():
        raise HTTPException(
            status_code=422,
            detail="Refusing to train: dataset contains NaN or infinite values.",
        )
    if float(torch.std(y)) < 1e-8:
        raise HTTPException(
            status_code=422,
            detail="Refusing to train: dataset carries no signal (zero variance).",
        )
    return x, y

class ForecastRequest(BaseModel):
    data: List[List[float]]
    horizon: int = 24

class TrainRequest(BaseModel):
    epochs: int = Field(50, ge=1, le=500)
    batch_size: int = Field(32, ge=1, le=1024)
    data_source: str = Field(..., description="Provenance of the dataset; must be a real, validated source. Synthetic/random noise is rejected.")
    train_data: List[List[List[float]]] = Field(..., description="Training samples, shape (n, seq_len, input_dim).")
    train_labels: List[List[float]] = Field(..., description="Training labels, shape (n, pred_len).")
    val_data: Optional[List[List[List[float]]]] = None
    val_labels: Optional[List[List[float]]] = None

@router.post("/demand/forecast")
async def forecast_demand(request: ForecastRequest):
    """Forecast demand using transformer"""
    try:
        # Convert to tensor
        x = torch.tensor(request.data, dtype=torch.float32)
        if len(x.shape) == 2:
            x = x.unsqueeze(0)  # Add batch dimension
        
        # Predict
        predictions = demand_trainer.predict(x)
        
        return {
            'success': True,
            'data': {
                'predictions': predictions.tolist(),
                'horizon': request.horizon,
                'type': 'demand'
            },
            'timestamp': datetime.now().isoformat()
        }
    except Exception as e:
        logger.error(f"Demand forecast failed: {e}")
        logger.error(f"Internal error: {e}")

        raise HTTPException(status_code=500, detail="Internal server error")

@router.post("/traffic/forecast")
async def forecast_traffic(request: ForecastRequest):
    """Forecast traffic using transformer"""
    try:
        x = torch.tensor(request.data, dtype=torch.float32)
        if len(x.shape) == 2:
            x = x.unsqueeze(0)
        
        predictions = traffic_trainer.predict(x)
        
        return {
            'success': True,
            'data': {
                'predictions': predictions.tolist(),
                'horizon': request.horizon,
                'type': 'traffic'
            },
            'timestamp': datetime.now().isoformat()
        }
    except Exception as e:
        logger.error(f"Traffic forecast failed: {e}")
        logger.error(f"Internal error: {e}")

        raise HTTPException(status_code=500, detail="Internal server error")

@router.post("/price/forecast")
async def forecast_price(request: ForecastRequest):
    """Forecast price using transformer"""
    try:
        x = torch.tensor(request.data, dtype=torch.float32)
        if len(x.shape) == 2:
            x = x.unsqueeze(0)
        
        predictions = price_trainer.predict(x)
        
        return {
            'success': True,
            'data': {
                'predictions': predictions.tolist(),
                'horizon': request.horizon,
                'type': 'price'
            },
            'timestamp': datetime.now().isoformat()
        }
    except Exception as e:
        logger.error(f"Price forecast failed: {e}")
        logger.error(f"Internal error: {e}")

        raise HTTPException(status_code=500, detail="Internal server error")

@router.post("/demand/train")
async def train_demand(request: TrainRequest):
    """Train demand forecast transformer on validated real data."""
    try:
        train_data, train_labels = _validate_training_dataset(
            data_source=request.data_source,
            data=request.train_data,
            labels=request.train_labels,
            seq_len=demand_model.transformer.seq_len,
            input_dim=demand_model.input_dim,
            pred_len=demand_model.transformer.pred_len,
        )
        val_data = None
        val_labels = None
        if request.val_data is not None and request.val_labels is not None:
            val_data, val_labels = _validate_training_dataset(
                data_source=request.data_source,
                data=request.val_data,
                labels=request.val_labels,
                seq_len=demand_model.transformer.seq_len,
                input_dim=demand_model.input_dim,
                pred_len=demand_model.transformer.pred_len,
                min_samples=1,
            )
        
        results = demand_trainer.train(
            train_data, train_labels,
            epochs=request.epochs,
            batch_size=request.batch_size,
            val_data=val_data,
            val_labels=val_labels
        )
        
        return {
            'success': True,
            'data': results,
            'timestamp': datetime.now().isoformat()
        }
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Training failed: {e}")
        logger.error(f"Internal error: {e}")

        raise HTTPException(status_code=500, detail="Internal server error")

@router.post("/traffic/train")
async def train_traffic(request: TrainRequest):
    """Train traffic forecast transformer on validated real data."""
    try:
        train_data, train_labels = _validate_training_dataset(
            data_source=request.data_source,
            data=request.train_data,
            labels=request.train_labels,
            seq_len=traffic_model.transformer.seq_len,
            input_dim=traffic_model.transformer.input_dim,
            pred_len=traffic_model.transformer.pred_len,
        )
        val_data = None
        val_labels = None
        if request.val_data is not None and request.val_labels is not None:
            val_data, val_labels = _validate_training_dataset(
                data_source=request.data_source,
                data=request.val_data,
                labels=request.val_labels,
                seq_len=traffic_model.transformer.seq_len,
                input_dim=traffic_model.transformer.input_dim,
                pred_len=traffic_model.transformer.pred_len,
                min_samples=1,
            )
        
        results = traffic_trainer.train(
            train_data, train_labels,
            epochs=request.epochs,
            batch_size=request.batch_size,
            val_data=val_data,
            val_labels=val_labels
        )
        
        return {
            'success': True,
            'data': results,
            'timestamp': datetime.now().isoformat()
        }
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Training failed: {e}")
        logger.error(f"Internal error: {e}")

        raise HTTPException(status_code=500, detail="Internal server error")

@router.post("/price/train")
async def train_price(request: TrainRequest):
    """Train price forecast transformer on validated real data."""
    try:
        train_data, train_labels = _validate_training_dataset(
            data_source=request.data_source,
            data=request.train_data,
            labels=request.train_labels,
            seq_len=price_model.transformer.seq_len,
            input_dim=price_model.transformer.input_dim,
            pred_len=price_model.transformer.pred_len,
        )
        val_data = None
        val_labels = None
        if request.val_data is not None and request.val_labels is not None:
            val_data, val_labels = _validate_training_dataset(
                data_source=request.data_source,
                data=request.val_data,
                labels=request.val_labels,
                seq_len=price_model.transformer.seq_len,
                input_dim=price_model.transformer.input_dim,
                pred_len=price_model.transformer.pred_len,
                min_samples=1,
            )
        
        results = price_trainer.train(
            train_data, train_labels,
            epochs=request.epochs,
            batch_size=request.batch_size,
            val_data=val_data,
            val_labels=val_labels
        )
        
        return {
            'success': True,
            'data': results,
            'timestamp': datetime.now().isoformat()
        }
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Training failed: {e}")
        logger.error(f"Internal error: {e}")

        raise HTTPException(status_code=500, detail="Internal server error")

@router.get("/model-info")
async def get_model_info():
    """Get model information"""
    try:
        return {
            'success': True,
            'data': {
                'demand': {
                    'input_dim': demand_model.input_dim,
                    'seq_len': demand_model.transformer.seq_len,
                    'pred_len': demand_model.transformer.pred_len,
                    'parameters': sum(p.numel() for p in demand_model.parameters())
                },
                'traffic': {
                    'input_dim': traffic_model.input_dim,
                    'seq_len': traffic_model.transformer.seq_len,
                    'pred_len': traffic_model.transformer.pred_len,
                    'parameters': sum(p.numel() for p in traffic_model.parameters())
                },
                'price': {
                    'input_dim': price_model.input_dim,
                    'seq_len': price_model.transformer.seq_len,
                    'pred_len': price_model.transformer.pred_len,
                    'parameters': sum(p.numel() for p in price_model.parameters())
                },
                'device': str(demand_trainer.device)
            },
            'timestamp': datetime.now().isoformat()
        }
    except Exception as e:
        logger.error(f"Model info failed: {e}")
        logger.error(f"Internal error: {e}")

        raise HTTPException(status_code=500, detail="Internal server error")