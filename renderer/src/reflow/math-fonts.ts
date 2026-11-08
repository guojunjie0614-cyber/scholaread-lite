/** MathTime fonts are common in IEEE PDFs alongside Computer Modern; AdvP4C4E, AdvPSMP and AdvPi are Elsevier's math sets. */
export const MATH_FONT = /CM(?:MI|SY|EX|R|SS|TI)\d|LMMath|LMSymbol|LMRoman|LMExtension|MathJax|STIX|Symbol|Euclid|MTSYN?|MTEX|R?MTMI|AdvP4C4E|AdvPSMP|AdvPi\d/i;
export const MATH_SYMBOL = /[=×∗∑∏∫√≈≠≤≥±∞∂∇α-ωΓΔΘΛΞΠΣΦΨΩ∈∉⊂⊃∪∩∀∃]/;
export const MATH_EXTENSION_FONT = /CMEX|LMExtension|MTEX/i;
