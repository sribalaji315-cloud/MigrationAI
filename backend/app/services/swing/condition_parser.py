"""Condition DSL parser — faithful Python port of the reference engine's
``ConditionParser`` (CondToken / CondLexer / CondNode / CondParser).

Grammar (AND binds tighter than OR)::

    expr    := or
    or      := and ( 'or' and )*
    and     := primary ( 'and' primary )*
    primary := '(' or ')' | ATTRIBUTE ( '=' | '<>' ) STRING_LIT

Where ``ATTRIBUTE`` is ``.*IDENT`` (the ``.*`` prefix is stripped from the
token value) and ``STRING_LIT`` is a single-quoted literal (no escaping).

The reference deliberately has a couple of quirks that are preserved here for
exact parity:

* Unknown characters are silently skipped by the lexer (never an error).
* ``primary`` reads the attribute, decides the operator from the *next* token,
  then unconditionally advances one token before reading the value.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum, auto
from typing import List


class CondTokenType(Enum):
    LPAREN = auto()
    RPAREN = auto()
    EQ = auto()
    NEQ = auto()
    AND = auto()
    OR = auto()
    ATTRIBUTE = auto()
    STRING_LIT = auto()
    EOF = auto()


@dataclass(frozen=True)
class CondToken:
    type: CondTokenType
    value: str


# --- AST nodes -------------------------------------------------------------
@dataclass
class ComparisonNode:
    attribute: str
    op: str  # "=" or "<>"
    value: str


@dataclass
class BinaryNode:
    op: str  # "AND" or "OR"
    children: List[object] = field(default_factory=list)


@dataclass
class LiteralNode:
    value: bool


class CondFormatError(ValueError):
    """Raised for malformed condition expressions (maps to Review)."""


class CondLexer:
    def __init__(self, text: str):
        self._input = text or ""
        self._pos = 0

    def _skip_whitespace(self) -> None:
        while self._pos < len(self._input) and self._input[self._pos].isspace():
            self._pos += 1

    def next(self) -> CondToken:
        while True:
            self._skip_whitespace()
            if self._pos >= len(self._input):
                return CondToken(CondTokenType.EOF, "")

            ch = self._input[self._pos]

            if ch == "(":
                self._pos += 1
                return CondToken(CondTokenType.LPAREN, "(")
            if ch == ")":
                self._pos += 1
                return CondToken(CondTokenType.RPAREN, ")")
            if ch == "=":
                self._pos += 1
                return CondToken(CondTokenType.EQ, "=")

            if (
                self._pos + 1 < len(self._input)
                and ch == "<"
                and self._input[self._pos + 1] == ">"
            ):
                self._pos += 2
                return CondToken(CondTokenType.NEQ, "<>")

            # Attribute: .*IDENT
            if (
                self._pos + 1 < len(self._input)
                and ch == "."
                and self._input[self._pos + 1] == "*"
            ):
                self._pos += 2
                start = self._pos
                while self._pos < len(self._input) and (
                    self._input[self._pos].isalnum() or self._input[self._pos] == "_"
                ):
                    self._pos += 1
                return CondToken(CondTokenType.ATTRIBUTE, self._input[start:self._pos])

            # String literal: '...'
            if ch == "'":
                self._pos += 1
                start = self._pos
                while self._pos < len(self._input) and self._input[self._pos] != "'":
                    self._pos += 1
                val = self._input[start:self._pos]
                if self._pos < len(self._input):
                    self._pos += 1
                return CondToken(CondTokenType.STRING_LIT, val)

            # Keywords: and / or (case-insensitive, word-boundary checked)
            if (
                self._pos + 3 <= len(self._input)
                and self._input[self._pos:self._pos + 3].lower() == "and"
                and (
                    self._pos + 3 >= len(self._input)
                    or not self._input[self._pos + 3].isalnum()
                )
            ):
                self._pos += 3
                return CondToken(CondTokenType.AND, "and")

            if (
                self._pos + 2 <= len(self._input)
                and self._input[self._pos:self._pos + 2].lower() == "or"
                and (
                    self._pos + 2 >= len(self._input)
                    or not self._input[self._pos + 2].isalnum()
                )
            ):
                self._pos += 2
                return CondToken(CondTokenType.OR, "or")

            # Skip unknown characters (loop continues).
            self._pos += 1


class CondParser:
    def __init__(self, text: str):
        lexer = CondLexer(text)
        self._tokens: List[CondToken] = []
        while True:
            tok = lexer.next()
            self._tokens.append(tok)
            if tok.type == CondTokenType.EOF:
                break
        self._pos = 0

    def _peek(self) -> CondToken:
        if self._pos < len(self._tokens):
            return self._tokens[self._pos]
        return CondToken(CondTokenType.EOF, "")

    def _advance(self) -> CondToken:
        tok = self._tokens[self._pos]
        self._pos += 1
        return tok

    def _match(self, type_: CondTokenType) -> bool:
        if self._peek().type != type_:
            return False
        self._advance()
        return True

    def parse(self):
        return self._parse_or()

    def _parse_or(self):
        children = [self._parse_and()]
        while self._peek().type == CondTokenType.OR:
            self._advance()
            children.append(self._parse_and())
        return children[0] if len(children) == 1 else BinaryNode("OR", children)

    def _parse_and(self):
        children = [self._parse_primary()]
        while self._peek().type == CondTokenType.AND:
            self._advance()
            children.append(self._parse_primary())
        return children[0] if len(children) == 1 else BinaryNode("AND", children)

    def _parse_primary(self):
        if self._match(CondTokenType.LPAREN):
            node = self._parse_or()
            if not self._match(CondTokenType.RPAREN):
                raise CondFormatError(f"Missing closing ')' at position {self._pos}")
            return node

        if self._peek().type == CondTokenType.ATTRIBUTE:
            attr = self._advance().value
            op = "<>" if self._peek().type == CondTokenType.NEQ else "="
            self._advance()  # unconditional advance (mirrors reference quirk)
            val = self._advance().value if self._peek().type == CondTokenType.STRING_LIT else ""
            return ComparisonNode(attr, op, val)

        peeked = self._peek()
        raise CondFormatError(
            f"Unexpected token: {peeked.type} '{peeked.value}' at position {self._pos}"
        )
