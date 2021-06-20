# grasp2mp4 - Convert GRASP .gl files into MP4
This node.js program converts GRASP .gl animation files into MP4 files. Requires 'deark' and 'ffmpeg' to be installed on the system.

Note: This just does a 'passable' rendering. It doesn't do any of the fancy fades or animations that GRASP supported.
It also doesn't get all the speed and timings quite right.
But it's good enough to get a 'grasp' of what the original .gl file originally displayed as.

### Usage
```
Usage: grasp2mp4 [options] <graspFilePath> <outDirPath>

Convert a GRASP GL file into one or more MP4 files

Arguments:
  graspFilePath              Input grasp.gl file path
  outDirPath                 Output directory

Options:
  -V, --version              output the version number
  -f, --force                Overwrite any existing MP4 files in outDirPath
  -r, --rate <value>         Frame rate to use for output video (default: 30)
  -k, --keep                 Keep temporary working files around
  -q, --quiet                Don't output any progress messages
  -v, --verbose              Be extra chatty
      --maxDuration <value>  Maximum duration of video, in seconds (default: 300)
  -h, --help                 display help for command
```

### FAQ
* Why can't I specify the output file path directly? Why a directory?

A single .gl file can contain many scripts, each being a different animation, thus muliple output MP4 files.
