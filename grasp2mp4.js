#!/usr/bin/env node
"use strict";
const XU = require("@sembiance/xu"),
	fileUtil = require("@sembiance/xutil").file,
	runUtil = require("@sembiance/xutil").run,
	cmdUtil = require("@sembiance/xutil").cmd,
	gd = require("node-gd"),
	fs = require("fs"),
	path = require("path"),
	tiptoe = require("tiptoe");

const argv = cmdUtil.cmdInit({
	version     : "1.0.0",
	desc : "Convert a GRASP GL file into one or more MP4 files",
	opts        :
	{
		force       : {desc : "Overwrite any existing MP4 files in outDirPath"},
		rate        : {desc : "Frame rate to use for output video", defaultValue : 30},
		keep        : {desc : "Keep temporary working files around"},
		quiet       : {desc : "Don't output any progress messages"},
		verbose     : {desc : "Be extra chatty"},
		debug       : {desc : "Output lots of extra stuff to help in debugging"},
		maxDuration : {desc : "Maximum duration of video, in seconds", noShort : true, defaultValue : 300}
	},
	args :
	[
		{argid : "graspFilePath", desc : "Input grasp.gl file path", required : true},
		{argid : "outDirPath", desc : "Output directory", required : true}
	]});

const MAX_SPEED = 10000;	// max speed allowed in GRASP spec
const SLOWEST_SPEED_DURATION = XU.SECOND*3;
const MAX_FRAMES = argv.rate*argv.maxDuration;

if(!fileUtil.existsSync(argv.graspFilePath))
	process.exit(XU.log`graspFilePath file path ${argv.graspFilePath} does not exist`);

function grasp2mp4(cb)
{
	if(!fileUtil.existsSync(argv.outDirPath))
		fs.mkdirSync(argv.outDirPath, {recursive : true});

	const wipDirPath = fileUtil.generateTempFilePath();
	fs.mkdirSync(wipDirPath, {recursive : true}, this);

	const glFilesDirPath = fileUtil.generateTempFilePath(wipDirPath, "-glFilesDirPath");
	fs.mkdirSync(glFilesDirPath, {recursive : true}, this);

	tiptoe(
		function extractGLFiles()
		{
			runUtil.run("deark", ["-od", glFilesDirPath, "-o", "_", argv.graspFilePath], runUtil.SILENT, this);
		},
		function findGLFiles()
		{
			fileUtil.glob(glFilesDirPath, "**", {nodir : true}, this);
		},
		function processScriptFile(glFilePaths)
		{
			const scripts = {};
			const baseState =
			{
				glFilesDirPath,
				outDirPath : argv.outDirPath,
				picPaths   : {},
				clipPaths  : {},
				wipDirPath
			};

			glFilePaths.forEach(glFilePath =>
			{
				// Rename files so they don't have the dexvert prefix. We assume all filenames will be unique
				const newFilePath = path.join(path.dirname(glFilePath), path.basename(glFilePath).replace(/^_\.\d+\./, ""));
				fs.renameSync(glFilePath, newFilePath);
				const fileNameNoExt = path.basename(newFilePath, path.extname(newFilePath));

				const glFileExt = path.extname(glFilePath).toLowerCase();
				if(glFileExt===".txt")
				{
					// Scripts end with .txt
					const scriptContent = fs.readFileSync(newFilePath, XU.UTF8);
					scripts[fileNameNoExt] = scriptContent.includes("\n") ? scriptContent.replaceAll("\r", "").split("\n") : scriptContent.split("\r");
				}
				else if(glFileExt===".pic")
				{
					baseState.picPaths[fileNameNoExt] = newFilePath;
					baseState.picPaths[path.basename(newFilePath)] = newFilePath;
				}
				else if(glFileExt===".clp")
				{
					baseState.clipPaths[fileNameNoExt] = newFilePath;
					baseState.clipPaths[path.basename(newFilePath)] = newFilePath;
				}
			});
	
			Object.entries(scripts).serialForEach(([scriptName, scriptLines], subcb) => processScript({...baseState, scriptName, scriptLines}, subcb), this);
		},
		function cleanup()
		{
			if(!argv.quiet)
				XU.log`All done! Cleaning up...`;

			if(argv.keep)
			{
				XU.log`Keeping files in dir ${wipDirPath}`;
				this();
			}
			else
			{
				fileUtil.unlink(wipDirPath, this);
			}
		},
		cb
	);
}

function processScript(state, cb)
{
	if(!argv.quiet)
		XU.log`Processing script ${state.scriptName} with ${state.scriptLines.length} lines...`;

	state.framesDirPath = fileUtil.generateTempFilePath(state.wipDirPath, "-framesDirPath");
	fs.mkdirSync(state.framesDirPath);

	const outMP4FilePath = path.join(state.outDirPath, `${state.scriptName}.mp4`);
	if(fileUtil.existsSync(outMP4FilePath))
	{
		if(!argv.force)
		{
			if(!argv.quiet)
				XU.log`Skipping ${state.scriptName} due to output MP4 already existing: ${outMP4FilePath}`;
			return setImmediate(cb);
		}
		
		fileUtil.unlinkSync(outMP4FilePath);
	}

	state.l = 0;				// Current line being executed
	state.drawingColor = 0xFCFC54;	// Default GRASP color on startup?
	state.frames = [];			// An array of GD image frames to use for the video
	state.duration = 0;			// Current duration of video
	state.labels = {};			// label : lineNum
	state.marks = {};			// lineNum : count
	state.picBuf = {};			// Loaded GD images from PLOAD
	state.clipBuf = {};			// Loaded GD images from CLOAD

	tiptoe(
		function processLines()
		{
			processLine(state, this);
		},
		function writeFramesToDisk()
		{
			if(!argv.quiet)
				XU.log`Writing frames to disk...`;
			
			const frameFilename = function frameFilename(frameNum)
			{
				return `${frameNum.toString().padStart(9, "0")}.png`;
			};

			state.frames.parallelForEach((frame, subcb, i) =>
			{
				if(frame===".")
				{
					let prevRealFrame=i-1;
					for(;state.frames[prevRealFrame]===".";prevRealFrame--)
						;

					fs.symlink(frameFilename(prevRealFrame), path.join(state.framesDirPath, frameFilename(i)), subcb);
				}
				else
				{
					fs.writeFile(path.join(state.framesDirPath, frameFilename(i)), frame.pngPtr(), {encoding : null}, subcb);
				}
			}, this, {atOnce : 20});
		},
		function makeMovie()
		{
			if(!argv.quiet)
				XU.log`Making movie from frames...`;

			const ffmpegArgs = ["-r", argv.rate, "-f", "image2", "-s", state.video.resolution.join("x"), "-i", `%09d.png`];
			ffmpegArgs.push("-c:v", "libx264", "-crf", "15", "-preset", "slow", "-pix_fmt", "yuv420p", "-movflags", "faststart", path.resolve(outMP4FilePath));
			runUtil.run("ffmpeg", ffmpegArgs, {cwd : state.framesDirPath, silent : true}, this);
		},
		cb
	);
}

const msg = (state, msgData, cb) =>
{
	XU.log`${state.scriptName}@${(state.l+1).toLocaleString().padStart(state.scriptLines.length.toLocaleString().length, " ")}: ${XU.cf.fg.white(msgData)}`;
	if(cb)
		setImmediate(cb);
};

// Converts a GRASP 'delay' into milliseconds
function delayToMS(delay)
{
	return XU.SECOND*(+delay/100);
}

// Converts a GRASP 'speed' into milliseconds
function speedToMS(speed)
{
	return SLOWEST_SPEED_DURATION-Number(+speed).scale(0, MAX_SPEED, 0, SLOWEST_SPEED_DURATION);
}

// Converts a millisecond duration into frame count
function msToFrameCount(ms)
{
	return Math.floor(ms/(XU.SECOND/argv.rate));
}

// Repeats the previous frame for ms duration
function repeatFrame(state, ms)
{
	for(let d=msToFrameCount(ms);d>0;d--)
		state.frames.push(".");
}

// Parses an arg string for a command, it's compliant with either comma or space delimiters and extra whitespace all over
function parseArg(argRaw, _argsIn)
{
	const argChars = argRaw.split("");
	const argsIn = Array.from(_argsIn);
	const args = {};

	//XU.log`${argRaw}`;

	function skipChars(chars)
	{
		let skipCount = 0;
		const charsRegexp = new RegExp(`[${chars}]`);
		while(argChars.length>0 && charsRegexp.test(argChars[0]))
		{
			argChars.shift();
			skipCount++;
		}

		return skipCount;
	}

	function getChars(chars)
	{
		const outChars = [];
		const charsRegexp = new RegExp(`[${chars}]`);
		while(argChars.length>0 && charsRegexp.test(argChars[0]))
			outChars.push(argChars.shift());
		
		return outChars.join("");
	}

	const getVal =
	{
		"num" : () => +getChars("\\d"),
		"letter" : () => argChars.shift(),
		"str" : () =>
		{
			const quoted = skipChars('"');
			const str = getChars(quoted ? '^"' : "^, ");
			skipChars('"');
			return str;
		}
	};

	let isRange = false;
	while(argChars.length>0 && argsIn.length>0)
	{
		const argIn = argsIn.shift();
		skipChars("\\s");

		if(argChars[0]==="-")
		{
			isRange = true;
			argChars.shift();
			skipChars("\\s");
		}

		let argVal = getVal[argIn.type]();
		if(argIn.transform)
			argVal = argIn.transform(argVal);

		if(argIn.repeating)
		{
			if(!args.hasOwnProperty(argIn.argid))
				args[argIn.argid] = [];
			
			if(isRange)
				args[argIn.argid].pushSequence(args[argIn.argid].last()+1, argVal);
			else
				args[argIn.argid].push(argVal);
		}
		else
		{
			args[argIn.argid] = argVal;
		}
		skipChars("\\s,");

		if(argIn.repeating)
			argsIn.unshift(argIn);
	}

	if(argv.debug)
		XU.log`${argRaw} => ${args}`;

	return args;
}

const cmds = {};

////////////////// VIDEO - Change video mode/resolution //////////////////
cmds.VIDEO = (argRaw, state, cb) =>
{
	const {mode} = parseArg(argRaw, [
		{argid : "mode", type : "letter", transform : v => v.toUpperCase()}
	]);

	if(state.video)
		return msg(state, `VIDEO Changing video mode more than once is not currently supported`, cb);

	const MODES =
	{
		/* eslint-disable array-bracket-spacing, no-multi-spaces, max-len */
		"0" : {resolution : [ 40,  25], colors :  16, type : "IBM 40 column text"},
		"1" : {resolution : [ 80,  25], colors :  16, type : "IBM 80 column text"},
		"2" : {resolution : [ 80,  25], colors :   2, type : "IBM 80 column text"},
		"A" : {resolution : [320, 200], colors :   4, type : "IBM CGA"},
		"B" : {resolution : [320, 200], colors :  16, type : "IBM PCjr/STB"},
		"C" : {resolution : [640, 200], colors :   2, type : "IBM CGA"},
		"D" : {resolution : [640, 200], colors :  64, type : "IBM EGA"},
		"E" : {resolution : [640, 350], colors :   2, type : "IBM EGA monochrome"},
		"F" : {resolution : [640, 350], colors :   4, type : "IBM EGA"},
		"G" : {resolution : [640, 350], colors :  64, type : "IBM EGA", palette : [0x000000, 0x0000AA, 0x00AA00, 0x00AAAA, 0xAA0000, 0xAA00AA, 0xAAAA00, 0xAAAAAA, 0x000055, 0x0000FF, 0x00AA55, 0x00AAFF, 0xAA0055, 0xAA00FF, 0xAAAA55, 0xAAAAFF, 0x005500, 0x0055AA, 0x00FF00, 0x00FFAA, 0xAA5500, 0xAA55AA, 0xAAFF00, 0xAAFFAA, 0x005555, 0x0055FF, 0x00FF55, 0x00FFFF, 0xAA5555, 0xAA55FF, 0xAAFF55, 0xAAFFFF, 0x550000, 0x5500AA, 0x55AA00, 0x55AAAA, 0xFF0000, 0xFF00AA, 0xFFAA00, 0xFFAAAA, 0x550055, 0x5500FF, 0x55AA55, 0x55AAFF, 0xFF0055, 0xFF00FF, 0xFFAA55, 0xFFAAFF, 0x555500, 0x5555AA, 0x55FF00, 0x55FFAA, 0xFF5500, 0xFF55AA, 0xFFFF00, 0xFFFFAA, 0x555555, 0x5555FF, 0x55FF55, 0x55FFFF, 0xFF5555, 0xFF55FF, 0xFFFF55]},
		"H" : {resolution : [720, 348], colors :   2, type : "Hercules monochrome"},
		"I" : {resolution : [320, 200], colors :  16, type : "Plantronics/AST CGP"},
		"J" : {resolution : [320, 200], colors :  16, type : "IBM EGA"},
		// Modes below this line were not documented in the 1.10c docs, looking for further docs
		"L" : {resolution : [320, 200], colors : 256, type : "IBM VGA", palette : [0x000000, 0x0000A8, 0x00A800, 0x00A8A8, 0xA80000, 0xA800A8, 0xA85400, 0xA8A8A8, 0x545454, 0x5454FC, 0x54FC54, 0x54FCFC, 0xFC5454, 0xFC54FC, 0xFCFC54, 0xFCFCFC, 0x000000, 0x141414, 0x202020, 0x2C2C2C, 0x383838, 0x444444, 0x505050, 0x606060, 0x707070, 0x808080, 0x909090, 0xA0A0A0, 0xB4B4B4, 0xC8C8C8, 0xE0E0E0, 0xFCFCFC, 0x0000FC, 0x4000FC, 0x7C00FC, 0xBC00FC, 0xFC00FC, 0xFC00BC, 0xFC007C, 0xFC0040, 0xFC0000, 0xFC4000, 0xFC7C00, 0xFCBC00, 0xFCFC00, 0xBCFC00, 0x7CFC00, 0x40FC00, 0x00FC00, 0x00FC40, 0x00FC7C, 0x00FCBC, 0x00FCFC, 0x00BCFC, 0x007CFC, 0x0040FC, 0x7C7CFC, 0x9C7CFC, 0xBC7CFC, 0xDC7CFC, 0xFC7CFC, 0xFC7CDC, 0xFC7CBC, 0xFC7C9C, 0xFC7C7C, 0xFC9C7C, 0xFCBC7C, 0xFCDC7C, 0xFCFC7C, 0xDCFC7C, 0xBCFC7C, 0x9CFC7C, 0x7CFC7C, 0x7CFC9C, 0x7CFCBC, 0x7CFCDC, 0x7CFCFC, 0x7CDCFC, 0x7CBCFC, 0x7C9CFC, 0xB4B4FC, 0xC4B4FC, 0xD8B4FC, 0xE8B4FC, 0xFCB4FC, 0xFCB4E8, 0xFCB4D8, 0xFCB4C4, 0xFCB4B4, 0xFCC4B4, 0xFCD8B4, 0xFCE8B4, 0xFCFCB4, 0xE8FCB4, 0xD8FCB4, 0xC4FCB4, 0xB4FCB4, 0xB4FCC4, 0xB4FCD8, 0xB4FCE8, 0xB4FCFC, 0xB4E8FC, 0xB4D8FC, 0xB4C4FC, 0x000070, 0x1C0070, 0x380070, 0x540070, 0x700070, 0x700054, 0x700038, 0x70001C, 0x700000, 0x701C00, 0x703800, 0x705400, 0x707000, 0x547000, 0x387000, 0x1C7000, 0x007000, 0x00701C, 0x007038, 0x007054, 0x007070, 0x005470, 0x003870, 0x001C70, 0x383870, 0x443870, 0x543870, 0x603870, 0x703870, 0x703860, 0x703854, 0x703844, 0x703838, 0x704438, 0x705438, 0x706038, 0x707038, 0x607038, 0x547038, 0x447038, 0x387038, 0x387044, 0x387054, 0x387060, 0x387070, 0x386070, 0x385470, 0x384470, 0x505070, 0x585070, 0x605070, 0x685070, 0x705070, 0x705068, 0x705060, 0x705058, 0x705050, 0x705850, 0x706050, 0x706850, 0x707050, 0x687050, 0x607050, 0x587050, 0x507050, 0x507058, 0x507060, 0x507068, 0x507070, 0x506870, 0x506070, 0x505870, 0x000040, 0x100040, 0x200040, 0x300040, 0x400040, 0x400030, 0x400020, 0x400010, 0x400000, 0x401000, 0x402000, 0x403000, 0x404000, 0x304000, 0x204000, 0x104000, 0x004000, 0x004010, 0x004020, 0x004030, 0x004040, 0x003040, 0x002040, 0x001040, 0x202040, 0x282040, 0x302040, 0x382040, 0x402040, 0x402038, 0x402030, 0x402028, 0x402020, 0x402820, 0x403020, 0x403820, 0x404020, 0x384020, 0x304020, 0x284020, 0x204020, 0x204028, 0x204030, 0x204038, 0x204040, 0x203840, 0x203040, 0x202840, 0x2C2C40, 0x302C40, 0x342C40, 0x3C2C40, 0x402C40, 0x402C3C, 0x402C34, 0x402C30, 0x402C2C, 0x40302C, 0x40342C, 0x403C2C, 0x40402C, 0x3C402C, 0x34402C, 0x30402C, 0x2C402C, 0x2C4030, 0x2C4034, 0x2C403C, 0x2C4040, 0x2C3C40, 0x2C3440, 0x2C3040, 0x000000, 0x000000, 0x000000, 0x000000, 0x000000, 0x000000, 0x000000, 0x000000]}
		/* eslint-enable array-bracket-spacing, no-multi-spaces, max-len */
	};

	if(!MODES[mode])
		return msg(state, `VIDEO Unsupported mode ${mode} (${argRaw})`, cb);
	
	state.video = MODES[mode];
	state.screen = gd.createTrueColorSync(...state.video.resolution);

	cb();
};

////////////////// PLOAD - Load a pic into a picBuf //////////////////
cmds.PLOAD = (argRaw, state, cb) =>
{
	const {imageName, bufNum} = parseArg(argRaw, [
		{argid : "imageName", type : "str"},
		{argid : "bufNum", type : "num"}
	]);
	state.picBuf[bufNum] = imageName;
	cb();
};

////////////////// PALETTE - Set the current pallete from a pic in picBuf //////////////////
cmds.PALETTE = (argRaw, state, cb) =>
{
	const {bufNum} = parseArg(argRaw, [
		{argid : "bufNum", type : "num"}
	]);
	if(!state.picBuf[bufNum])
		return msg(state, `PALETTE No pic buf loaded in ${bufNum} (${argRaw})`, cb);

	if(state.palette)
	{
		state.palette.image.destroy();
		delete state.palette;
	}

	tiptoe(
		function loadPaletteImage()
		{
			loadImage(state, bufNum, "pic", this);
		},
		function extractPaletteColors([image])
		{
			state.palette = {image, filePath : state.picPaths[state.picBuf[bufNum].toLowerCase()]};
			state.paletteColors = [];
			
			for(let i=0;i<image.colorsTotal;i++)
			{
				const pixel = gd.createSync(1, 1);
				image.paletteCopy(pixel);
				pixel.setPixel(0, 0, i);
				state.paletteColors.push(pixel.getTrueColorPixel(0, 0));
				pixel.destroy();
			}

			this();
		},
		cb
	);
};

////////////////// PFREE - Frees the given picture picBuf pics //////////////////
cmds.PFREE = (argRaw, state, cb) =>
{
	const {bufNums} = parseArg(argRaw, [
		{argid : "bufNums", type : "num", repeating : true}
	]);
	bufNums.forEach(bufNum =>
	{
		if(state.picBuf[bufNum])
			delete state.picBuf[bufNum];
	});

	cb();
};

////////////////// CFREE - Frees the given picture clipBuf clips //////////////////
cmds.CFREE = (argRaw, state, cb) =>
{
	const {bufNums} = parseArg(argRaw, [
		{argid : "bufNums", type : "num", repeating : true}
	]);
	bufNums.forEach(bufNum =>
	{
		if(state.clipBuf[bufNum])
			delete state.clipBuf[bufNum];
	});

	cb();
};

////////////////// CFREE - Clears the screen to the current drawing color //////////////////
cmds.CLEARSCR = (argRaw, state, cb) =>
{
	const frame = gd.createTrueColorSync(...state.video.resolution);
	frame.fill(0, 0, state.drawingColor);
	state.frames.push(frame);
	state.screen = frame;

	cb();
};

////////////////// CLOAD - Loads a clip into a clipBuf //////////////////
cmds.CLOAD = (argRaw, state, cb) =>
{
	const {imageName, bufNum} = parseArg(argRaw, [
		{argid : "imageName", type : "str"},
		{argid : "bufNum", type : "num"}
	]);
	state.clipBuf[bufNum] = imageName;
	cb();
};

////////////////// FLY/FLOAT - Animate 1 or more clipBuf clips between two points on the screen //////////////////
cmds.FLY = (...args) => flyFloat("fly", ...args);
cmds.FLOAT = (...args) => flyFloat("float", ...args);
function flyFloat(type, argRaw, state, cb)
{
	const {startX, startY, endX, endY, increment, delay, clipNums} = parseArg(argRaw, [
		{argid : "startX", type : "num"},
		{argid : "startY", type : "num"},
		{argid : "endX", type : "num"},
		{argid : "endY", type : "num"},
		{argid : "increment", type : "num"},
		{argid : "delay", type : "num"},
		{argid : "clipNums", type : "num", repeating : true}
	]);

	const clipNumsUnique = clipNums.unique();

	tiptoe(
		function loadImages()
		{
			loadImage(state, clipNumsUnique, "clip", this);
		},
		function createFrames(images)
		{
			let x = startX;
			let y = startY;
			let seenAllClips = false;
			const clipsLeft = Array.from(clipNums);
			let lastFrame = null;
			for(;x!==endX || y!==endY || (!seenAllClips && clipsLeft.length>0);)
			{
				if(clipsLeft.length===0)
				{
					seenAllClips = true;
					clipsLeft.push(...clipNums);
				}

				if(startX<endX)
				{
					x += increment;
					x = Math.min(x, endX);
				}
				else if(startX>endX)
				{
					x -= Math.abs(increment);
					x = Math.max(x, endX);
				}

				if(startY<endY)
				{
					y += increment;
					y = Math.min(y, endY);
				}
				else if(startY>endY)
				{
					y -= Math.abs(increment);
					y = Math.max(y, endY);
				}

				const frame = gd.createFromPngPtr(state.screen.pngPtr());
				const clipImage = images[clipNumsUnique.indexOf(clipsLeft.shift())];
				clipImage.copy(frame, x, y, 0, 0, clipImage.width, clipImage.height);
				state.frames.push(frame);

				// FLY will actually copy to the screen and leave remnants behind, FLOAT will only leave the last frame
				lastFrame = frame;
				if(type==="fly")
					state.screen = frame;
				
				repeatFrame(state, delayToMS(delay));
			}

			state.screen = lastFrame;
			this();
		},
		function finish(err) { cb(err); }
	);
}

////////////////// GOTO - Jump to the given label in the program //////////////////
cmds.GOTO = (argRaw, state, cb) =>
{
	const {labelName} = parseArg(argRaw, [
		{argid : "labelName", type : "str"}
	]);
	if(!state.labels.hasOwnProperty(labelName))
		return msg(state, `GOTO Label not found yet ${labelName}`, cb);
	
	if(argv.verbose)
		msg(state, `GOTO Jumping to label ${labelName} at line ${state.labels[labelName]}`);

	cb(undefined, state.labels[labelName]);
};

////////////////// MARK - Marks the place that the next LOOP will return to //////////////////
cmds.MARK = (argRaw, state, cb) =>
{
	// If we've already found a mark on this line, just continue
	if(state.marks.hasOwnProperty(state.l))
		return cb();

	const {markCount} = parseArg(argRaw, [
		{argid : "markCount", type : "num"}
	]);

	state.marks[state.l] = +markCount;
	cb();
};

////////////////// LOOP - Will loop back up to the nearest MARK that still has counts remaining //////////////////
cmds.LOOP = (argRaw, state, cb) =>
{
	const targetMarkLine = Object.entries(state.marks).filter(([markLine, markCount]) => markCount>0 && (+markLine)<state.l).map(([markLine]) => +markLine).multiSort([v => +v]).pop();
	if(typeof targetMarkLine==="undefined")
		return cb();

	if(argv.verbose)
		msg(state, `LOOP Looping back to ${targetMarkLine} with ${state.marks[targetMarkLine]} loops remaining...`);
	state.marks[targetMarkLine]--;
	cb(undefined, targetMarkLine);
};

////////////////// COLOR - Set the current drawing and secondary color //////////////////
cmds.COLOR = (argRaw, state, cb) =>
{
	const {drawingColor, secondaryColor=undefined} = parseArg(argRaw, [
		{argid : "drawingColor", type : "num"},
		{argid : "secondaryColor", type : "num"}
	]);
	state.drawingColor = state.video.palette[drawingColor];
	if(typeof secondaryColor!=="undefined")
		state.secondaryColor = secondaryColor;
	
	cb();
};

////////////////// BOX - Draws a box on the screen //////////////////
cmds.BOX = (argRaw, state, cb) =>
{
	const {startX, startY, endX, endY, width=1} = parseArg(argRaw, [
		{argid : "startX", type : "num"},
		{argid : "startY", type : "num"},
		{argid : "endX", type : "num"},
		{argid : "endY", type : "num"},
		{argid : "width", type : "num"}
	]);
	const frame = gd.createFromPngPtr(state.screen.pngPtr());
	[[startX, startY, endX, startY+width], [startX, startY, startX+width, endY], [endX-width, startY, endX, endY], [startX, endY-width, endX, endY]].forEach(([sx, sy, ex, ey]) => frame.filledRectangle(sx, sy, ex, ey, state.drawingColor));
	state.frames.push(frame);
	state.screen = frame;

	cb();
};

////////////////// WAITKEY - Wait for a user to press a key, which will never happen, then optionally GOTO a label //////////////////
cmds.WAITKEY = (argRaw, state, cb) =>
{
	const {duration, labelName} = parseArg(argRaw, [
		{argid : "duration", type : "num"},
		{argid : "labelName", type : "str"}
	]);

	repeatFrame(state, delayToMS(+duration));
	cb(undefined, state.labels[labelName] || undefined);
};

////////////////// TEXT - Draws text to the screen //////////////////
cmds.TEXT = (argRaw, state, cb) =>
{
	const {textX, textY, text, delay=0} = parseArg(argRaw, [
		{argid : "textX", type : "num"},
		{argid : "textY", type : "num"},
		{argid : "text", type : "str"},
		{argid : "delay", type : "num"}
	]);
	const frame = gd.createFromPngPtr(state.screen.pngPtr());
	// Since we don't support custom fonts and we are just using Consolas at size 10, fonts often end up in weird sports on the scren, but oh well
	// Also, for some reason the Y coordinates are measured from the bottom of the screen instead of the top. Weird.
	frame.stringFT(state.drawingColor, path.join(__dirname, "Consolas.ttf"), 10, 0, (+textX), state.video.resolution[1]-((+textY)+10), text);
	state.frames.push(frame);
	state.screen = frame;

	repeatFrame(state, delayToMS(delay));
	cb();
};

////////////////// CFADE - Fades a clip to the screen at X/Y coordinates //////////////////
cmds.CFADE = (argRaw, state, cb) =>
{
	const {fadeNum, fadeX, fadeY, bufNum=0, speed=MAX_SPEED*0.98, delay=0} = parseArg(argRaw, [	// eslint-disable-line no-unused-vars
		{argid : "fadeNum", type : "num"},
		{argid : "fadeX", type : "num"},
		{argid : "fadeY", type : "num"},
		{argid : "bufNum", type : "num"},
		{argid : "speed", type : "num"},
		{argid : "delay", type : "num"}
	]);
	if(bufNum===0)
		return msg("CFADE Unsupported bufNum 0", cb);

	tiptoe(
		function loadFadeImage()
		{
			loadImage(state, bufNum, "clip", this);
		},
		function writeFrame([image])
		{
			const frame = gd.createFromPngPtr(state.screen.pngPtr());
			image.copy(frame, +fadeX, +fadeY, 0, 0, image.width, image.height);
			state.frames.push(frame);
			state.screen = frame;

			repeatFrame(state, speedToMS(speed)+delayToMS(delay));

			this();
		},
		cb
	);
};

////////////////// PFADE - Fades a picture to the screen //////////////////
cmds.PFADE = (argRaw, state, cb) =>
{
	const {fadeNum, bufNum=0, speed=MAX_SPEED*0.98, delay=0} = parseArg(argRaw, [	// eslint-disable-line no-unused-vars
		{argid : "fadeNum", type : "num"},
		{argid : "bufNum", type : "num"},
		{argid : "speed", type : "num"},
		{argid : "delay", type : "num"}
	]);

	tiptoe(
		function loadFadeImage()
		{
			if(bufNum===0)
			{
				const image = gd.createTrueColorSync(...state.video.resolution);
				image.fill(0, 0, state.drawingColor);
				this(undefined, [image]);
			}
			else
			{
				loadImage(state, bufNum, "pic", this);
			}
		},
		function writeFrame([image])
		{
			const frame = gd.createFromPngPtr(state.screen.pngPtr());
			image.copy(frame, 0, 0, 0, 0, image.width, image.height);
			state.frames.push(frame);
			state.screen = frame;

			repeatFrame(state, speedToMS(speed)+delayToMS(delay));

			this();
		},
		cb
	);
};

// Commands we know about but are not supporting at this time
const UNSUPPORTED_COMMANDS = ["EXIT", "DLOAD", "DFREE", "FLOAD", "NOTE", "PUTDFF"];

// Will convert (using state.palette if set) and load the image into a GD image
const LOADED_IMAGES = [];
function loadImage(state, bufNums, imageType, cb)
{
	let prepDirPath = null;

	Array.force(bufNums).parallelForEach((bufNum, subcb) =>
	{
		const imageName = state[`${imageType}Buf`][bufNum];
		if(!imageName)
			XU.log`${XU.cf.fg.red("ERROR")}: Failed to find ${imageType} image for buf #${bufNum}`;
			
		const loadedImage = LOADED_IMAGES.find(o => o.imageName===imageName && o.imageType===imageType && o.palette===state.palette?.filePath);
		if(loadedImage)
			return setImmediate(() => subcb(undefined, loadedImage.image));

		if(!prepDirPath)
		{
			prepDirPath = fileUtil.generateTempFilePath(state.wipDirPath, "-loadImage");
			fs.mkdirSync(prepDirPath);
		}

		tiptoe(
			function convertImage()
			{
				const dearkArgs = ["-od", prepDirPath, "-o", `${imageType}-${imageName}`, "-m", "pcpaint"];
				if(state.palette)
					dearkArgs.push("-file2", state.palette.filePath);

				dearkArgs.push(state[`${imageType}Paths`][imageName]);

				runUtil.run("deark", dearkArgs, runUtil.SILENT, this);
			},
			function loadIntoBuf()
			{
				const imageFilePath = path.join(prepDirPath, `${imageType}-${imageName}.000.png`);
				const gdImage = gd.createFromPngPtr(fs.readFileSync(imageFilePath)).createPaletteFromTrueColor();
				LOADED_IMAGES.push({imageName, imageType, palette : state.palette?.filePath, image : gdImage});
				this(undefined, gdImage);
			},
			subcb
		);
	}, cb, {atOnce : 20});
}

function processLine(state, cb)
{
	if(state.frames.length>=MAX_FRAMES)
		return setImmediate(cb);

	const scriptLine = state.scriptLines[state.l];
	tiptoe(
		function parseLine()
		{
			if(scriptLine.trim().length===0 || scriptLine.trim().startsWith(";"))
				return this();

			// First check to see if we are defining a label
			const {labelName} = (scriptLine.match(/^(?<labelName>\S+):/) || {groups : {}}).groups;
			if(labelName)
			{
				if(state.labels[labelName])
					XU.log`Line ${state.l} has duplicate label ${labelName} which was already defined at l ine ${state.labels[labelName]}`;
				else
					state.labels[labelName] = state.l+1;
				
				return this();
			}

			const {cmdRaw, argRaw} = (scriptLine.match(/^(?<cmdRaw>\S+) ?(?<argRaw>[^;]+)?\s*;?.*$/) || {groups : {}}).groups;
			if(!cmdRaw)
			{
				msg(state, `No command found: [${scriptLine}]`);
				return this();
			}

			const cmd = cmds[cmdRaw.toUpperCase()];
			if(!cmd)
			{
				if(state.l+1<state.scriptLines.length)
				{
					if(UNSUPPORTED_COMMANDS.includes(cmdRaw.toUpperCase()))
					{
						if(argv.debug)
							msg(state, `KNOWN unsupported command: ${cmdRaw}`);
					}
					else
					{
						msg(state, `NEW UNKNOWN COMMAND: ${cmdRaw}`);
					}
				}
				return this();
			}

			cmd(argRaw, state, this);
		},
		function processNextLine(err, nextLine)
		{
			if(err)
				process.exit(XU.log`${XU.cf.fg.red("ERROR")} ${state.scriptName}@${state.l+1}: ${err}`);
			
			if(!["undefined", "number"].includes(typeof nextLine))
			{
				console.trace();
				process.exit(XU.log`${XU.cf.fg.red("ERROR")} ${state.scriptName}@${state.l+1}: Invalid nextLine returned`);
			}

			if(typeof nextLine!=="undefined")
				state.l = nextLine;
			else if(state.l+1===state.scriptLines.length)
				return setImmediate(cb);
			else
				state.l++;
			
			setImmediate(() => processLine(state, cb));
		}
	);
}

grasp2mp4(XU.FINISH);
