"""Dotted config-key paths: splitting, literal-key matching, and free-form section keys.

Every config key is addressed as a dotted path (``compression.model_thresholds.<model>``), but a
key *name* may itself contain a dot — model IDs (``glm-5.3``), Matrix room IDs
(``!room:chat.example.cc``), provider names. Callers therefore cannot split on ``.`` blindly.

Three complementary mechanisms live here:

1. ``_split_key_path`` — the escape syntax (``a\\.b`` -> ``a.b``).
2. ``_greedy_literal_match`` / ``_phantom_sibling`` — prefer an existing literal key equal to the
   dot-join of the next N segments, and refuse to create an intermediate mapping that shadows one.
3. ``escape_free_form_key_tail`` — the remaining gap: the FIRST write of a dotted key into an empty
   free-form section has no existing literal to match, so it silently nested a phantom the runtime
   never reads (``model_thresholds: {"z-ai/glm-5": {"3": 0.9}}``).
"""

from __future__ import annotations

from typing import Any, Optional

from hermes_cli.config_defaults import DEFAULT_CONFIG


def _split_key_path(key: str) -> list[str]:
    """Split a dotted config-key path, honoring backslash-escaped dots (``a\\.b`` -> ``a.b``).
    Backslashes before any other character are preserved verbatim.

    ``hermes config set`` uses ``.`` as the nesting separator, so a key that itself contains a literal dot
    (e.g. provider names like ``qwen3.5-397b-wafer``) was silently split into bogus nested segments
    (#84064).
    """
    parts: list[str] = []
    current: list[str] = []
    i = 0
    while i < len(key):
        ch = key[i]
        if ch == "\\" and key[i + 1:i + 2] == ".":
            current.append(".")
            i += 2
            continue
        if ch == ".":
            parts.append("".join(current))
            current = []
        else:
            current.append(ch)
        i += 1
    parts.append("".join(current))
    return parts


def _greedy_literal_match(container: dict, parts: list) -> Optional[tuple[str, int]]:
    """Return ``(literal_key, n_consumed)`` for the longest dotted literal key present in
    *container*, or None. With no multi-segment literal this is the historic plain-split walk.

    Dots in config key names are the norm, not the exception — model IDs (``grok-4.6``, ``glm-5.3``), Matrix
    room IDs (``!room:chat.example.cc``), and versioned provider names all embed dots. Users typing
    ``providers.myprov.models.grok-4.6.context_length`` do not know the escape syntax exists, so when
    navigating an EXISTING mapping we prefer an existing literal key equal to the dot-join of the next N
    path segments (longest match wins) over blindly splitting. See #84064 / #80006 / 91095 / #91607 /
    #99124.
    """
    if not isinstance(container, dict) or not parts:
        return None
    return next(
        ((".".join(parts[:n]), n) for n in range(len(parts), 0, -1) if ".".join(parts[:n]) in container),
        None)


def _phantom_sibling(container: dict, part: str) -> Optional[str]:
    """Existing literal dotted key that creating an intermediate mapping ``part`` would shadow
    (``grok-4`` beside ``grok-4.5``) — the write would produce a phantom sibling the runtime never
    reads, so callers fail loudly instead.

    Called when a write is about to CREATE a new intermediate mapping named ``part``. See #84064.
    """
    if not isinstance(container, dict):
        return None
    prefix = part + "."
    return next((k for k in container if isinstance(k, str) and k.startswith(prefix)), None)


# Free-form mapping sections whose entries are FLAT ``name -> scalar`` maps: a dot in the name is part
# of the key, not a nesting separator (``compression.model_thresholds.<model>``,
# ``terminal.docker_env.<VAR>``). DEFAULT_CONFIG cannot express this — an empty dict is ambiguous between
# a flat map and a named container (``providers``, ``lsp.servers``, ``hooks``), where the name is a
# user-chosen key with schema beneath — so the flat ones are listed explicitly. Sections that are NOT
# listed keep the historic behaviour: an existing literal key is greedy-matched, and creating a new
# dotted one requires escaping.
_FLAT_FREE_FORM_SECTIONS = frozenset({
    "agent.reasoning_overrides",
    "compression.model_thresholds",
    "delegation.request_overrides",
    "discord.channel_prompts",
    "display.status_phrases",
    "mattermost.channel_prompts",
    "matrix.channel_prompts",
    "monitoring.export.otlp.headers_env",
    "onboarding.seen",
    "secrets.onepassword.env",
    "slack.channel_prompts",
    "telegram.channel_prompts",
    "terminal.docker_env",
    "web.provider_tier",
})
#: ``auxiliary.<task>.extra_body`` — one flat section per auxiliary task.
_FLAT_FREE_FORM_SECTION_SUFFIXES = (".extra_body",)


def _is_flat_free_form_section(section_path: str) -> bool:
    """True when *section_path* names a free-form section whose keys are flat ``name -> scalar``."""
    return (
        section_path in _FLAT_FREE_FORM_SECTIONS
        or section_path.endswith(_FLAT_FREE_FORM_SECTION_SUFFIXES)
    )


def _flat_free_form_tail_index(segments: list[str]) -> Optional[int]:
    """Index in *segments* where a flat free-form section's user-chosen keys begin, or None.

    Walks DEFAULT_CONFIG exactly as ``_validate_config_key`` does and stops at the first empty-dict
    leaf, reporting it only when that section is a known flat map. Returns None for a named container
    (``providers``, ``lsp.servers``, ``hooks``) and for any path that stays inside a populated schema
    section, so those keep their historic split.
    """
    if not segments:
        return None
    node: Any = DEFAULT_CONFIG.get(segments[0])
    if not isinstance(node, dict):
        return None
    for idx in range(1, len(segments)):
        section_path = ".".join(segments[:idx])
        if _is_flat_free_form_section(section_path):
            return idx
        if not isinstance(node, dict) or not node:
            return None
        if segments[idx] not in node:
            # Not enumerated in DEFAULT_CONFIG (``matrix.channel_prompts``): a flat section
            # registered under the next segment still earns the literal-key reading.
            nxt = ".".join(segments[: idx + 1])
            return idx + 1 if idx + 1 < len(segments) and _is_flat_free_form_section(nxt) else None
        node = node[segments[idx]]
    return None


def escape_free_form_key_tail(dotted_key: str) -> str:
    """Backslash-escape the dots that lie inside a flat free-form section of *dotted_key*.

    Lets a user-chosen key containing a dot be written literally on the first attempt, without knowing
    the escape syntax: ``compression.model_thresholds.z-ai/glm-5.3`` lands on the real ``z-ai/glm-5.3``
    entry rather than a nested ``z-ai/glm-5: {3: ...}`` phantom the runtime never reads. Keys outside a
    flat free-form section, and dots the caller already escaped, are left exactly as given.
    """
    segments = _split_key_path(dotted_key)
    idx = _flat_free_form_tail_index(segments)
    if idx is None or idx >= len(segments):
        return dotted_key
    # Escape every UNescaped separator past the boundary (separator k sits between segments k-1 and
    # k, so the tail starts after separator ``idx``). Already-escaped dots pass through verbatim, which
    # makes this idempotent.
    out: list[str] = []
    separators = 0
    i = 0
    while i < len(dotted_key):
        if dotted_key[i:i + 2] == "\\.":
            out.append("\\.")
            i += 2
            continue
        ch = dotted_key[i]
        if ch == ".":
            separators += 1
            out.append("\\." if separators > idx else ".")
        else:
            out.append(ch)
        i += 1
    return "".join(out)
