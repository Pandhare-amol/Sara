from __future__ import annotations

from dataclasses import asdict, dataclass, field
from typing import Any, Dict


@dataclass
class UIElement:
    role: str = ""
    name: str = ""
    text: str = ""
    bounds: Dict[str, int] = field(default_factory=dict)
    x: int = 0
    y: int = 0
    width: int = 0
    height: int = 0
    visible: bool = False
    enabled: bool = False
    focused: bool = False
    clickable: bool = False
    application: str = ""
    window: str = ""
    accessibility_id: str = ""
    automation_id: str = ""
    confidence: float = 0.0
    source: str = "COORDINATE"
    metadata: Dict[str, Any] = field(default_factory=dict)

    def __post_init__(self) -> None:
        if not self.bounds:
            self.bounds = {"x": self.x, "y": self.y, "width": self.width, "height": self.height}
        self.x = int(self.bounds.get("x", self.x) or 0)
        self.y = int(self.bounds.get("y", self.y) or 0)
        self.width = int(self.bounds.get("width", self.width) or 0)
        self.height = int(self.bounds.get("height", self.height) or 0)

    @property
    def center(self) -> Dict[str, int]:
        return {"x": int(self.x + self.width / 2), "y": int(self.y + self.height / 2)}

    def to_dict(self) -> Dict[str, Any]:
        data = asdict(self)
        data["center"] = self.center
        return data


def element_from_dict(data: Dict[str, Any]) -> UIElement:
    bounds = data.get("bounds") or {}
    x = int(data.get("x", bounds.get("x", 0)) or 0)
    y = int(data.get("y", bounds.get("y", 0)) or 0)
    width = int(data.get("width", bounds.get("width", 0)) or 0)
    height = int(data.get("height", bounds.get("height", 0)) or 0)
    return UIElement(
        role=str(data.get("role") or ""),
        name=str(data.get("name") or ""),
        text=str(data.get("text") or ""),
        bounds={"x": x, "y": y, "width": width, "height": height},
        x=x,
        y=y,
        width=width,
        height=height,
        visible=bool(data.get("visible", True)),
        enabled=bool(data.get("enabled", True)),
        focused=bool(data.get("focused", False)),
        clickable=bool(data.get("clickable", data.get("enabled", True))),
        application=str(data.get("application") or ""),
        window=str(data.get("window") or ""),
        accessibility_id=str(data.get("accessibility_id") or ""),
        automation_id=str(data.get("automation_id") or ""),
        confidence=float(data.get("confidence") or 0.0),
        source=str(data.get("source") or "COORDINATE"),
        metadata=dict(data.get("metadata") or {}),
    )
