/** MathTime fonts are common in IEEE PDFs alongside Computer Modern. */
export const MATH_FONT = /CM(?:MI|SY|EX|R|SS|TI)\d|LMMath|LMSymbol|LMRoman|LMExtension|MathJax|STIX|Symbol|Euclid|MTSYN?|MTEX|R?MTMI/i;
export const MATH_SYMBOL = /[=×∗∑∏∫√≈≠≤≥±∞∂∇α-ωΓΔΘΛΞΠΣΦΨΩ∈∉⊂⊃∪∩∀∃]/;
export const MATH_EXTENSION_FONT = /CMEX|LMExtension|MTEX/i;
