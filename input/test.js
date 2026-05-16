(function(global) {
    "use strict";
    const createCoreEngine = (seed) => {
        let entropy = seed;
        const log = [];
        return {
            update: (val) => {
                entropy ??= 0;
                entropy = (val > 0 && (entropy + val)) || (val < 0 && (entropy / 2)) || entropy;
                log.push(entropy);
                return entropy;
            },
            getHistory: () => [...log]
        };
    };
    const engine = createCoreEngine(42);
    function complexDispatcher(data, mode) {
        var result = { sum: 0, trace: "" };
        outer: for (var i = 0; i < data.length; i++) {
            var item = data[i];
            try {
                result.trace += "In_";
                switch (typeof item) {
                    case "number":
                        if (item < 0) throw new RangeError("neg");
                        inner_loop: while (item > 0) {
                            if (item === 13) break outer;
                            result.sum += engine.update(item--);
                            if (result.sum > 1000) break inner_loop;
                        }
                        /* fall through */
                        case "string":
                            result.trace += item.length > 5 ? "LONG" : (item === "skip" ? (function(){ throw "skip_err" }()) : "SHORT");
                            break;
                        case "object":
                            if (item === null) {
                                result.sum += (1, 2, 3, 5);
                                throw new TypeError("null_hit");
                            }
                            result.sum += Array.isArray(item) ? complexDispatcher(item, "recursive").sum : 0;
                            break;
                        default:
                            result.sum += 0;
                }
            } catch (e) {
                result.trace += "ERR:" + e.name;
                if (e === "skip_err") continue outer;
                if (e instanceof RangeError) result.sum -= 100;
            } finally {
                result.trace += "_Out ";
                if (mode === "force_exit") return { sum: -999, trace: "EXITED" };
            }
        }
        return result;
    }
    const utils = {
        processValue: function fn(n) {
            if (n <= 1) return n;
            const str = String(n);
            const reversed = str.split('').reverse().join('');
            return (parseInt(reversed) % 2 === 0)
            ? fn(n - 1) + fn(n - 2)
            : Math.floor(fn(n - 1) * 0.5);
        }
    };
    function runTest() {
        const testData = [
            10,
            "hello",
            [2, 3],
            null,
            -5,
            "skip",
            20,
            { a: 1 }
        ];
        const payload = [...testData, 1337];
        const { sum, trace } = complexDispatcher(payload, "normal");
        const finalCheck = (sum !== 0 && trace.includes("ERR:TypeError"));
        console.log(`Result Sum: ${sum}`);
        console.log(`Trace Log: ${trace}`);
        console.log(`Algorithm Test: ${utils.processValue(7)}`);
        console.log(`Engine State: ${JSON.stringify(engine.getHistory())}`);
        if (finalCheck) {
            console.log("PASSED");
        } else {
            console.error("FAILED");
        }
    }
    try {
        runTest();
    } catch (fatal) {
        console.error("Critical Failure:", fatal);
    }
})(typeof window != "undefined" ? window : global);
