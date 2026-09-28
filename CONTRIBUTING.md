## Contributing

[fork]: https://github.com/github/external-custom-properties-sample/fork
[pr]: https://github.com/github/external-custom-properties-sample/compare
[style]: https://github.com/github/external-custom-properties-sample/blob/main/example-server/eslint.config.mjs

Hi there! We're thrilled that you'd like to contribute to this project. Your help is essential for keeping it great.

Contributions to this project are [released](https://help.github.com/articles/github-terms-of-service/#6-contributions-under-repository-license) to the public under the [project's open source license](LICENSE).

Please note that this project is released with a [Contributor Code of Conduct](CODE_OF_CONDUCT.md). By participating in this project you agree to abide by its terms.

## Submitting a pull request

The npm project lives in `example-server/` rather than the repository root. Step 2 below changes into it, and the commands after that run from there.

1. [Fork][fork] and clone the repository
1. Configure and install the dependencies: `cd example-server && npm install`
1. Make sure the tests pass on your machine: `npm test`
1. Make sure the linter passes on your machine: `npm run lint`
1. Create a new branch: `git checkout -b my-branch-name`
1. Make your change, add tests, and make sure the tests and linter still pass
1. Push to your fork and [submit a pull request][pr]
1. Pat yourself on the back and wait for your pull request to be reviewed and merged.

Here are a few things you can do that will increase the likelihood of your pull request being accepted:

- Follow the [style guide][style].
- Write tests.
- Keep your change as focused as possible. If there are multiple changes you would like to make that are not dependent upon each other, consider submitting them as separate pull requests.
- Write a [good commit message](http://tbaggery.com/2008/04/19/a-note-about-git-commit-messages.html).

### A note on the shape of this project

This repository is a sample that people read and copy from, not a library they depend on. `example-server/app.js` is meant to be followed top to bottom, so changes that make it harder to read in exchange for internal flexibility are usually not worth it.

In particular, the tests deliberately run the server as a process and assert on its behaviour from the outside, rather than importing it. That keeps `app.js` free of exports and injection points that exist only for testing. Please preserve that when adding coverage.

## Resources

- [How to Contribute to Open Source](https://opensource.guide/how-to-contribute/)
- [Using Pull Requests](https://help.github.com/articles/about-pull-requests/)
- [GitHub Help](https://help.github.com)
