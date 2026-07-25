# Language — the architecture vocabulary

The canonical structural vocabulary. Use these terms exactly when you
reason or write about the shape of the code — don't substitute "component,"
"service," "API," or "boundary." Consistent language is the whole point: an audit,
a review, an ADR, and a PR description all mean the same thing by "deep module" or
"seam."

This file is **two layers**:

1. **The general architecture vocabulary** — module / interface / implementation /
   depth / seam / adapter / leverage / locality, the deletion test, and the other
   principles. Evergreen and project-agnostic; it ports the vocabulary the
   architecture-audit work is grounded in.
2. **The structural terms** — the project's own named structures (the test
   tiers, the fate loader/resolver split, the LiveDO roles), each anchored to the
   ADR that decided it. These are what the general vocabulary *names* when applied to
   this codebase.

---

## 1. The architecture vocabulary

### Terms

**Module**
Anything with an interface and an implementation. Deliberately scale-agnostic — it
applies equally to a function, a class, a package, or a tier-spanning slice.
_Avoid_: unit, component, service.

**Interface**
Everything a caller must know to use the module correctly. Includes the type
signature, but also invariants, ordering constraints, error modes, required
configuration, and performance characteristics.
_Avoid_: API, signature (too narrow — those refer only to the type-level surface).

**Implementation**
What's inside a module — its body of code. Distinct from **adapter**: a thing can be
a small adapter with a large implementation (a real D1-backed repository) or a large
adapter with a small implementation (an in-memory fake). Reach for "adapter" when the
seam is the topic; "implementation" otherwise.

**Depth**
Leverage at the interface — the amount of behaviour a caller (or test) can exercise
per unit of interface they have to learn. A module is **deep** when a large amount of
behaviour sits behind a small interface. A module is **shallow** when the interface is
nearly as complex as the implementation.

**Seam** _(from Michael Feathers)_
A place where you can alter behaviour without editing in that place. The *location* at
which a module's interface lives. Choosing where to put the seam is its own design
decision, distinct from what goes behind it.
_Avoid_: boundary (overloaded with DDD's bounded context).

**Adapter**
A concrete thing that satisfies an interface at a seam. Describes *role* (what slot it
fills), not substance (what's inside).

**Leverage**
What callers get from depth: more capability per unit of interface they have to learn.
One implementation pays back across N call sites and M tests.

**Locality**
What maintainers get from depth: change, bugs, knowledge, and verification concentrate
at one place rather than spreading across callers. Fix once, fixed everywhere.

### Principles

- **Depth is a property of the interface, not the implementation.** A deep module can
  be internally composed of small, mockable, swappable parts — they just aren't part
  of the interface. A module can have **internal seams** (private to its
  implementation, used by its own tests) as well as the **external seam** at its
  interface.
- **The deletion test.** Imagine deleting the module. If complexity vanishes, the
  module wasn't hiding anything (it was a pass-through). If complexity reappears across
  N callers, the module was earning its keep.
- **The interface is the test surface.** Callers and tests cross the same seam. If you
  want to test *past* the interface, the module is probably the wrong shape.
- **One adapter means a hypothetical seam. Two adapters means a real one.** Don't
  introduce a seam unless something actually varies across it.

### Relationships

- A **module** has exactly one **interface** (the surface it presents to callers and
  tests).
- **Depth** is a property of a **module**, measured against its **interface**.
- A **seam** is where a **module**'s **interface** lives.
- An **adapter** sits at a **seam** and satisfies the **interface**.
- **Depth** produces **leverage** for callers and **locality** for maintainers.

### Rejected framings

- **Depth as ratio of implementation-lines to interface-lines** (Ousterhout): rewards
  padding the implementation. We use depth-as-leverage instead.
- **"Interface" as the TypeScript `interface` keyword or a class's public methods**:
  too narrow — interface here includes every fact a caller must know.
- **"Boundary"**: overloaded with DDD's bounded context. Say **seam** or **interface**.

---

> This is the brand-noun seed. The full domain-noun glossary (the entities and their
> precise definitions) lives in its own `.glossary/TERMS.md`; this table fixes only the
> product/brand spellings and the Turkish-vs-English rule so they aren't duplicated in
> `CLAUDE.md`.

---

## See also

- [`.decisions/`](../.decisions/) — the *why* and the history behind every term
  here (an ADR is the source for each structural term).
- [`.patterns/`](../.patterns/index.md) — how the current code is shaped (the loader
  contract, the test seams, the DO wiring).
- [`CLAUDE.md`](../CLAUDE.md) — points here for the canonical vocabulary.
