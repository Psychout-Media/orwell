export ORWELL_BDD_FEATURES=docs/features/0160-belief-conviction.feature
npx tsc --noEmit -p . 2>&1 | head -5; echo TSC_DONE
echo "BASE unit $(npx vitest run tests/unit/beliefConviction.test.ts 2>&1 | sed 's/\x1b\[[0-9;]*m//g' | grep -E 'Tests ' | tail -1) bdd $(NODE_OPTIONS='--import tsx' npx cucumber-js 2>&1 | grep -E '^[0-9]+ scenarios|AssertionError' | head -2 | tr '\n' ' ')"
G=src/adapters/engine/GameSessionAdapter.ts; cp $G /tmp/mq3.bak
python3 - <<'P'
p="src/adapters/engine/GameSessionAdapter.ts";s=open(p).read()
a='return bound ? DEAL_NOMS.protectivePush * (BELIEF_RULES.strength === "full" ? dealTrust(this.rel.edge(holder, target).trust) : 1) : 0;'
assert s.count(a)==1;open(p,"w").write(s.replace(a,"return bound ? DEAL_NOMS.protectivePush : 0;",1))
P
echo "MUT deal-trust-ignored bdd $(NODE_OPTIONS='--import tsx' npx cucumber-js 2>&1 | grep -E '^[0-9]+ scenarios')"; cp /tmp/mq3.bak $G
