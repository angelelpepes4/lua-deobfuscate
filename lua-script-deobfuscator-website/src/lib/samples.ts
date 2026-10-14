export interface LuaSample {
  name: string;
  description: string;
  code: string;
}

export const SAMPLES: LuaSample[] = [
  {
    name: "Character codes",
    description: "string.char plus unreadable locals",
    code: `local IlIlIl=string.char(112,114,105,110,116)
local llIIll=string.char(72,101,108,108,111,44,32,76,117,97,33)
_G[IlIlIl](llIIll)`,
  },
  {
    name: "Nested loader",
    description: "Two loadstring wrappers and constant math",
    code: `loadstring("loadstring('return 6 * 7')()")()`,
  },
  {
    name: "Base64 payload",
    description: "Encoded source stored in a local",
    code: `local payload = "bG9jYWwgZnVuY3Rpb24gZ3JlZXQobmFtZSkgcHJpbnQoImhlbGxvICIgLi4gbmFtZSkgZW5kIGdyZWV0KCJ3b3JsZCIp"
loadstring(payload)()`,
  },
  {
    name: "Packed string table",
    description: "table.concat, string escapes, and arithmetic",
    code: `local chunks = {"return ", "(8 / 4) * 2"}
local source = table.concat(chunks)
loadstring(source)()`,
  },
  {
    name: "Minified module",
    description: "Formatting for ordinary Lua blocks",
    code: `local M={} function M.new(x,y) local s=setmetatable({},{__index=M}) s.x=x s.y=y return s end function M:len() return math.sqrt(self.x^2+self.y^2) end return M`,
  },
];