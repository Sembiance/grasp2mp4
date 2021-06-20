#!/usr/bin/env node
"use strict";
const XU = require("@sembiance/xu"),
	runUtil = require("@sembiance/xutil").run,
	fs = require("fs"),
	path = require("path");

fs.copyFileSync(process.argv[2], path.join(__dirname, "IN.GL"));
runUtil.run("dosbox", ["-conf", "dosbox.conf"], {cwd : __dirname, silent : true}, XU.FINISH);
