#!/usr/bin/env python3
"""A case ending hung on a number ("2027-es") is not a missing accent in scripts/hooks/outgoing-copy-gate.py.

The word regex of the accent audit starts a token after the hyphen, so "2027-es" used to put a bare "es" in front of the
accentless dictionary ("es" -> "es" with an acute accent) and a correct Hungarian message was refused (the Telegram reply
of the main agent, once the gate was registered for every tool).

Pinned here: the endings after "<digits>-" pass; a real accentless "es" next to them is still found; a word that is not
an ending after "<digits>-" is still judged; other checks are untouched.
Run: python3 <thisfile>   (OUTGOING_COPY_GATE_PATH names another gate file)   Exit 0 = all pass.
"""
import importlib.util
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
GATE = os.environ.get("OUTGOING_COPY_GATE_PATH") or os.path.join(os.path.dirname(HERE), "hooks", "outgoing-copy-gate.py")
spec = importlib.util.spec_from_file_location("outgoing_copy_gate", GATE)
g = importlib.util.module_from_spec(spec)
spec.loader.exec_module(g)

failed = []


def check(name, ok, detail=""):
    print(f"  [{'PASS' if ok else 'FAIL'}] {name}{(': ' + detail) if detail else ''}")
    if not ok:
        failed.append(name)


# Hungarian enough for the audit to run (three function words), with one number ending in it.
def sentence(token):
    return f"Szia, a {token} terv kész, és a többi is rendben van, de nem tudom hogy mikor lesz."


def missing(text):
    return [p for p in g.audit(text) if p.startswith("HIANYZO EKEZETEK")]


print("endings after a number pass")
for tok in ("2027-es", "10-es", "3-as", "5-os", "1-jen", "100-szor", "8-ig", "12-re", "4-edik", "2026-i"):
    check(tok, missing(sentence(tok)) == [], str(missing(sentence(tok)))[:100])
check("ending at the start of the text", missing("2027-es tervek, és a többi is rendben van, de nem tudom hogy mikor lesz.") == [])
check("two numbers with endings", missing("A 10-es és a 3-as kártya kész van, hogy a 2027-es is megvan, ez volt az 5-ös.") == [])
check("in a list line", missing("- 2027-es terv\n- 10-es kártya\nEz mind rendben van, de nem tudom hogy mikor lesz kész.") == [])

print("a real accentless es is still found")
found = missing("Szia, a 2027-es terv kész, es a többi is rendben van, de nem tudom hogy mikor lesz.")
check("standalone es next to 2027-es", len(found) == 1 and "es -> és" in found[0], str(found)[:140])
check("es after a number and a space", len(missing("Szia, a 2027 es a többi is rendben van, de nem tudom hogy mikor lesz.")) == 1)
check("es after a hyphen that follows no digit", len(missing("Szia, a terv -es a többi is rendben van, de nem tudom hogy mikor lesz.")) == 1)
check("a letter-hyphen compound stays one token (unchanged)", missing("Szia, a kulcs-es terv kész, és a többi is rendben van, de nem tudom hogy mikor lesz.") == [])

print("a word that is not an ending after a number is still judged")
check("5-ot (accentless form of 5-öt)", len(missing(sentence("5-ot"))) == 1, str(missing(sentence("5-ot")))[:100])
check("a dictionary word after 7-", len(missing(sentence("7-koszonom"))) == 1, str(missing(sentence("7-koszonom")))[:100])

print("other checks are untouched")
check("em dash still found", any(p.startswith("GONDOLATJEL") for p in g.audit("A 2027-es terv — kész, és a többi is rendben van.")))
check("an accentless sentence is still found", len(missing("Szia, itt van a licenckulcsod es a telepito.")) == 1)

if failed:
    print(f"\nFAILED: {len(failed)}: {failed}")
    sys.exit(1)
print("\nALL PASS")
