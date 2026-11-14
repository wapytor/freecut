// electron-builder's own icon/metadata step is switched off (it needs symlink rights on Windows),
// so stamp the FreeCut icon and version info into the exe here before the installer is built.
const path = require('path');

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'win32') return;
  const { rcedit } = await import('rcedit');
  const exe = path.join(context.appOutDir, context.packager.appInfo.productFilename + '.exe');
  await rcedit(exe, {
    icon: path.join(context.packager.projectDir, 'build', 'icon.ico'),
    'version-string': {
      ProductName: 'FreeCut',
      FileDescription: 'FreeCut video editor',
      OriginalFilename: 'FreeCut.exe',
      InternalName: 'FreeCut'
    }
  });
};
