"""
Conversation Manager for SARA Desktop Agent.

Manages multi-turn conversations, maintains dialogue state, extracts intent,
and generates contextual responses.
"""

import threading
import sqlite3
from dataclasses import dataclass, field
from enum import Enum
from typing import Dict, List, Optional, Tuple, Callable
from datetime import datetime, timedelta
import logging
import json

logger = logging.getLogger(__name__)


class ConversationTurn:
    """A single turn in a conversation."""
    
    def __init__(
        self,
        role: str,  # "user" or "assistant"
        content: str,
        timestamp: Optional[datetime] = None,
        intent: Optional[str] = None,
        entities: Optional[Dict[str, List[str]]] = None
    ):
        self.role = role
        self.content = content
        self.timestamp = timestamp or datetime.now()
        self.intent = intent
        self.entities = entities or {}
    
    def to_dict(self) -> Dict:
        return {
            "role": self.role,
            "content": self.content,
            "timestamp": self.timestamp.isoformat(),
            "intent": self.intent,
            "entities": self.entities
        }
    
    @classmethod
    def from_dict(cls, data: Dict) -> 'ConversationTurn':
        return cls(
            role=data["role"],
            content=data["content"],
            timestamp=datetime.fromisoformat(data.get("timestamp", datetime.now().isoformat())),
            intent=data.get("intent"),
            entities=data.get("entities")
        )


@dataclass
class ConversationState:
    """Complete state of a conversation."""
    conversation_id: str
    created_at: datetime = field(default_factory=datetime.now)
    last_turn_at: datetime = field(default_factory=datetime.now)
    turns: List[ConversationTurn] = field(default_factory=list)
    current_topic: Optional[str] = None
    previous_topic: Optional[str] = None
    user_intent: Optional[str] = None
    unanswered_questions: List[str] = field(default_factory=list)
    clarifications_needed: Dict[str, str] = field(default_factory=dict)
    quiet_mode: bool = False
    user_preference_context: Dict[str, str] = field(default_factory=dict)
    
    def get_context(self, max_turns: int = 10) -> List[Dict]:
        """Get conversation context for LLM (last N turns)."""
        recent_turns = self.turns[-max_turns:] if self.turns else []
        return [turn.to_dict() for turn in recent_turns]
    
    def add_turn(self, turn: ConversationTurn):
        """Add a turn to conversation."""
        self.turns.append(turn)
        self.last_turn_at = datetime.now()
        if turn.intent:
            self.user_intent = turn.intent


class IntentClassifier:
    """Simple intent classification from user messages."""
    
    # Intent patterns (simplified - in production would use ML)
    INTENT_PATTERNS = {
        "task_execution": ["run", "execute", "start", "do", "perform", "make", "build", "test"],
        "status_check": ["status", "how's", "what's", "check", "is it", "are there", "can you see"],
        "file_operation": ["file", "save", "open", "delete", "copy", "move", "read"],
        "help_request": ["help", "how do i", "how to", "what should", "suggest", "recommend"],
        "clarification": ["what", "which", "which one", "can you clarify", "do you mean"],
        "stop": ["stop", "cancel", "halt", "pause", "quit", "exit"],
        "continue": ["continue", "proceed", "keep going", "go on", "resume"],
        "preference_setting": ["prefer", "like", "want", "should", "always", "never"],
        "information": ["tell me", "what is", "when", "where", "why", "who"],
        "confirmation": ["yes", "okay", "ok", "right", "correct", "go ahead"],
        "negation": ["no", "don't", "not", "nope", "negative", "never mind"],
    }
    
    @classmethod
    def extract_intent(cls, text: str) -> Optional[str]:
        """Extract intent from user message."""
        text_lower = text.lower()
        
        # Check each intent pattern
        for intent, keywords in cls.INTENT_PATTERNS.items():
            for keyword in keywords:
                if keyword in text_lower:
                    return intent
        
        return None
    
    @classmethod
    def extract_entities(cls, text: str) -> Dict[str, List[str]]:
        """Extract entities from user message."""
        entities = {}
        
        # Simple entity extraction (would be more sophisticated in production)
        import re
        
        # File paths
        if "file" in text.lower() or ".txt" in text or ".py" in text:
            files = re.findall(r'[\w\-./\\]+\.\w+', text)
            if files:
                entities["files"] = files
        
        # Numbers (could be line numbers, counts, etc.)
        numbers = re.findall(r'\b\d+\b', text)
        if numbers:
            entities["numbers"] = numbers
        
        return entities


class ConversationHistory:
    """Persistent storage for conversations."""
    
    def __init__(self, db_path: str):
        self.db_path = db_path
        self._initialize_db()
    
    def _initialize_db(self):
        """Initialize database schema."""
        try:
            conn = sqlite3.connect(self.db_path)
            cursor = conn.cursor()
            
            cursor.execute('''
                CREATE TABLE IF NOT EXISTS conversations (
                    conversation_id TEXT PRIMARY KEY,
                    created_at REAL,
                    last_turn_at REAL,
                    current_topic TEXT,
                    previous_topic TEXT,
                    user_intent TEXT,
                    quiet_mode INTEGER,
                    archived INTEGER
                )
            ''')
            
            cursor.execute('''
                CREATE TABLE IF NOT EXISTS conversation_turns (
                    turn_id TEXT PRIMARY KEY,
                    conversation_id TEXT,
                    role TEXT,
                    content TEXT,
                    timestamp REAL,
                    intent TEXT,
                    entities TEXT,
                    FOREIGN KEY (conversation_id) REFERENCES conversations(conversation_id)
                )
            ''')
            
            conn.commit()
            conn.close()
        except Exception as e:
            logger.warning(f"Failed to initialize conversation history: {e}")
    
    def save_conversation(self, state: ConversationState):
        """Save conversation state to database."""
        try:
            conn = sqlite3.connect(self.db_path)
            cursor = conn.cursor()
            
            # Save conversation metadata
            cursor.execute('''
                INSERT OR REPLACE INTO conversations
                (conversation_id, created_at, last_turn_at, current_topic, previous_topic,
                 user_intent, quiet_mode, archived)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ''', (
                state.conversation_id,
                state.created_at.timestamp(),
                state.last_turn_at.timestamp(),
                state.current_topic,
                state.previous_topic,
                state.user_intent,
                int(state.quiet_mode),
                0
            ))
            
            # Save turns
            for i, turn in enumerate(state.turns):
                turn_id = f"{state.conversation_id}_turn_{i}"
                cursor.execute('''
                    INSERT OR REPLACE INTO conversation_turns
                    (turn_id, conversation_id, role, content, timestamp, intent, entities)
                    VALUES (?, ?, ?, ?, ?, ?, ?)
                ''', (
                    turn_id,
                    state.conversation_id,
                    turn.role,
                    turn.content,
                    turn.timestamp.timestamp(),
                    turn.intent,
                    json.dumps(turn.entities)
                ))
            
            conn.commit()
            conn.close()
        except Exception as e:
            logger.warning(f"Failed to save conversation: {e}")
    
    def load_conversation(self, conversation_id: str) -> Optional[ConversationState]:
        """Load conversation state from database."""
        try:
            conn = sqlite3.connect(self.db_path)
            cursor = conn.cursor()
            
            # Load conversation metadata
            cursor.execute('''
                SELECT created_at, last_turn_at, current_topic, previous_topic,
                       user_intent, quiet_mode
                FROM conversations
                WHERE conversation_id = ?
            ''', (conversation_id,))
            
            row = cursor.fetchone()
            if not row:
                conn.close()
                return None
            
            created_at, last_turn_at, current_topic, previous_topic, user_intent, quiet_mode = row
            
            # Load turns
            cursor.execute('''
                SELECT role, content, timestamp, intent, entities
                FROM conversation_turns
                WHERE conversation_id = ?
                ORDER BY timestamp ASC
            ''', (conversation_id,))
            
            turns = []
            for row in cursor.fetchall():
                role, content, timestamp, intent, entities_json = row
                entities = json.loads(entities_json) if entities_json else {}
                turn = ConversationTurn(
                    role=role,
                    content=content,
                    timestamp=datetime.fromtimestamp(timestamp),
                    intent=intent,
                    entities=entities
                )
                turns.append(turn)
            
            conn.close()
            
            state = ConversationState(
                conversation_id=conversation_id,
                created_at=datetime.fromtimestamp(created_at),
                last_turn_at=datetime.fromtimestamp(last_turn_at),
                turns=turns,
                current_topic=current_topic,
                previous_topic=previous_topic,
                user_intent=user_intent,
                quiet_mode=bool(quiet_mode)
            )
            
            return state
        except Exception as e:
            logger.warning(f"Failed to load conversation: {e}")
            return None


class ConversationManager:
    """
    Manages multi-turn conversations with SARA.
    
    Responsibilities:
    - Track conversation state and history
    - Extract user intent and entities
    - Generate clarifying questions
    - Maintain dialogue context
    - Handle conversation modes (quiet, verbose, etc.)
    """
    
    # Singleton instance
    _instance: Optional['ConversationManager'] = None
    _lock = threading.RLock()
    
    def __init__(self, db_path: Optional[str] = None):
        if db_path is None:
            from .sqlite_memory import data_root
            db_path = str(data_root() / "sara_memory.db")
        
        self.db_path = db_path
        self.history = ConversationHistory(db_path)
        self._current_conversation: Optional[ConversationState] = None
        self._intent_classifier = IntentClassifier()
        self._observers: List[Callable] = []
    
    @classmethod
    def get_instance(cls) -> 'ConversationManager':
        """Get or create singleton instance."""
        if cls._instance is None:
            with cls._lock:
                if cls._instance is None:
                    cls._instance = ConversationManager()
        return cls._instance
    
    def new_conversation(self, conversation_id: Optional[str] = None) -> ConversationState:
        """Start a new conversation."""
        if conversation_id is None:
            from datetime import datetime
            conversation_id = f"conv_{datetime.now().timestamp()}"
        
        state = ConversationState(conversation_id=conversation_id)
        with self._lock:
            self._current_conversation = state
        
        logger.info(f"Started new conversation: {conversation_id}")
        return state
    
    def get_current_conversation(self) -> Optional[ConversationState]:
        """Get current conversation state."""
        with self._lock:
            return self._current_conversation
    
    def set_current_conversation(self, conversation_id: str) -> Optional[ConversationState]:
        """Load and set a previous conversation."""
        state = self.history.load_conversation(conversation_id)
        if state:
            with self._lock:
                self._current_conversation = state
            logger.info(f"Loaded conversation: {conversation_id}")
        return state
    
    def add_user_message(self, content: str) -> Tuple[Optional[ConversationTurn], Optional[str]]:
        """
        Add user message to conversation.
        
        Returns: (turn_added, suggested_response_intent)
        """
        with self._lock:
            if self._current_conversation is None:
                self.new_conversation()
            
            conversation = self._current_conversation
            
            # Extract intent and entities
            intent = self._intent_classifier.extract_intent(content)
            entities = self._intent_classifier.extract_entities(content)
            
            # Create turn
            turn = ConversationTurn(
                role="user",
                content=content,
                intent=intent,
                entities=entities
            )
            
            # Update conversation state
            conversation.add_turn(turn)
            if intent:
                conversation.user_intent = intent
            
            # Determine if we need clarification
            clarification_intent = None
            if intent == "clarification":
                clarification_intent = "needs_clarification"
            elif intent == "help_request":
                clarification_intent = "provide_help"
            elif intent == "status_check":
                clarification_intent = "provide_status"
            
            # Notify observers
            for observer in self._observers:
                try:
                    observer("user_message", turn)
                except Exception as e:
                    logger.error(f"Error notifying observer: {e}")
            
            # Save conversation
            self.history.save_conversation(conversation)
            
            return turn, clarification_intent
    
    def add_assistant_message(self, content: str, intent: Optional[str] = None) -> ConversationTurn:
        """Add assistant message to conversation."""
        with self._lock:
            if self._current_conversation is None:
                self.new_conversation()
            
            conversation = self._current_conversation
            
            # Create turn
            turn = ConversationTurn(
                role="assistant",
                content=content,
                intent=intent
            )
            
            # Update conversation state
            conversation.add_turn(turn)
            
            # Notify observers
            for observer in self._observers:
                try:
                    observer("assistant_message", turn)
                except Exception as e:
                    logger.error(f"Error notifying observer: {e}")
            
            # Save conversation
            self.history.save_conversation(conversation)
            
            return turn
    
    def get_conversation_context(self, max_turns: int = 10) -> List[Dict]:
        """Get conversation context for LLM."""
        with self._lock:
            if self._current_conversation is None:
                return []
            return self._current_conversation.get_context(max_turns)
    
    def get_current_state(self) -> Optional[Dict]:
        """Get current conversation state as dict."""
        with self._lock:
            if self._current_conversation is None:
                return None
            
            state = self._current_conversation
            return {
                "conversation_id": state.conversation_id,
                "created_at": state.created_at.isoformat(),
                "turn_count": len(state.turns),
                "current_topic": state.current_topic,
                "user_intent": state.user_intent,
                "unanswered_questions": state.unanswered_questions,
                "quiet_mode": state.quiet_mode,
                "last_turn": state.turns[-1].to_dict() if state.turns else None
            }
    
    def set_quiet_mode(self, enabled: bool):
        """Enable/disable quiet mode (minimal responses)."""
        with self._lock:
            if self._current_conversation:
                self._current_conversation.quiet_mode = enabled
                self.history.save_conversation(self._current_conversation)
    
    def clear_conversation(self):
        """Clear current conversation."""
        with self._lock:
            self._current_conversation = None
    
    def generate_clarification_questions(self, user_message: str) -> List[str]:
        """Generate clarifying questions based on ambiguous user message."""
        questions = []
        
        # Example patterns
        if "file" in user_message.lower() and "which" not in user_message.lower():
            questions.append("Which file would you like me to work with?")
        
        if "do that" in user_message.lower() or "it" in user_message.lower():
            questions.append("Could you clarify what you'd like me to do?")
        
        if "here" in user_message.lower() or "there" in user_message.lower():
            questions.append("Where exactly should I look?")
        
        return questions
    
    def register_observer(self, callback: Callable):
        """Register for conversation events."""
        with self._lock:
            if callback not in self._observers:
                self._observers.append(callback)
    
    def unregister_observer(self, callback: Callable):
        """Unregister conversation observer."""
        with self._lock:
            if callback in self._observers:
                self._observers.remove(callback)
    
    def get_conversation_history(self, limit: int = 50) -> List[Dict]:
        """Get recent conversations for history view."""
        # This would query the database for recent conversations
        # Placeholder for now
        return []


def get_conversation_manager() -> ConversationManager:
    """Get the singleton conversation manager."""
    return ConversationManager.get_instance()
