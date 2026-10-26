#!/usr/bin/env bash
# Builds and packages the module, then runs every scenario in test/scenarios.mjs against the mock API.
# Scenarios that mostly wait (reconnects, timeouts) run in parallel; the rest run one after another.
# Output of each scenario goes to $TEST_WORK_DIR/out/<scenario>.txt. Exits non-zero when any check fails.
set -e

MODULE_DIR="$(cd "$(dirname "$0")/.." && pwd)"
TEST_WORK_DIR="${TMPDIR:-/tmp}/screenbird-companion-test"
export MODULE_DIR TEST_WORK_DIR
mkdir -p "$TEST_WORK_DIR"

# Self-signed certificate for the mock API on 127.0.0.1, created once.
if [ ! -f "$TEST_WORK_DIR/cert.pem" ]; then
	openssl req -x509 -newkey rsa:2048 -nodes -days 365 -keyout "$TEST_WORK_DIR/key.pem" -out "$TEST_WORK_DIR/cert.pem" \
		-config "$MODULE_DIR/test/cert.cnf" > /dev/null 2>&1
fi

cd "$MODULE_DIR"
./node_modules/.bin/tsc -p tsconfig.json --noEmit
./node_modules/.bin/rimraf dist
./node_modules/.bin/tsc -p tsconfig.build.json
./node_modules/.bin/companion-module-check > /dev/null
./node_modules/.bin/companion-module-build > /dev/null

OUT="$TEST_WORK_DIR/out"
rm -rf "$OUT" && mkdir "$OUT"
export NODE_EXTRA_CA_CERTS="$TEST_WORK_DIR/cert.pem"

run_scenario() {
	node "$MODULE_DIR/test/scenarios.mjs" "$1" > "$OUT/$1.txt" 2>&1
	echo "exit=$?" >> "$OUT/$1.txt"
}

set +e
for scenario in closecodes config nopong freeze revoked; do
	run_scenario "$scenario" &
done
for scenario in basic names colors refresh502 outoforder html ratelimit forbidden inactive scenesoff content403 \
	destroy cleanup apiurl burst nextscene handshake; do
	run_scenario "$scenario"
done
wait

failed_scenarios=0
for file in "$OUT"/*.txt; do
	name="$(basename "$file" .txt)"
	pass="$(grep -c '] PASS ' "$file")"
	fail="$(grep -c '] FAIL ' "$file")"
	if [ "$fail" -eq 0 ] && grep -q '^exit=0$' "$file"; then
		result=PASS
	else
		result=FAIL
		failed_scenarios=$((failed_scenarios + 1))
	fi
	printf '%-4s %-12s %3s passed, %s failed\n' "$result" "$name" "$pass" "$fail"
done

total="$(ls "$OUT"/*.txt | wc -l | tr -d ' ')"
if [ "$failed_scenarios" -gt 0 ]; then
	echo "$failed_scenarios of $total scenarios failed (details in $OUT)"
	exit 1
fi
echo "All $total scenarios passed"
