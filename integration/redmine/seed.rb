# frozen_string_literal: true

require 'json'
require 'securerandom'
require 'digest'

raise 'Not the disposable integration environment' unless ENV['MCP_INTEGRATION_ENV'] == 'wiki-only-disposable'
db = ActiveRecord::Base.connection_db_config.configuration_hash
raise 'Unexpected database' unless db[:database] == 'mcp_wiki_integration' && db[:host] == 'db'
raise 'Expected an empty test environment' unless Project.count.zero?
raise 'Unexpected Redmine source' unless File.read('/opt/redmine-source-commit').strip == 'f7ea71f9563ea7b346a8dbc7abb3854fc69321ea'
raise 'Unexpected Rails version' unless Rails.version == '8.1.4'

# No mail delivery and no API calls as admin during initialization or tests.
ActionMailer::Base.perform_deliveries = false
credentials = {}
users = []
project = nil
parent_fixture = nil
ActiveRecord::Base.transaction do
  Setting.rest_api_enabled = '1'
  Setting.login_required = '1'
  Setting.default_language = 'en'
  User.where(admin: true).each do |admin|
    admin.update!(status: User::STATUS_LOCKED)
  end
  project = Project.create!(name: 'Disposable MCP Wiki tests', identifier: 'mcp-wiki-integration',
                            is_public: false, enabled_module_names: ['wiki'])
  # Enabling the module creates a Wiki via an after_create callback. Reload to
  # avoid a cached nil association and accidentally creating a second Wiki.
  project.reload
  raise 'Expected one Wiki' unless project.wiki && Wiki.where(project_id: project.id).count == 1

  { 'with_rename' => true, 'without_rename' => false }.each do |name, rename|
    permissions = [:view_wiki_pages, :edit_wiki_pages]
    permissions << :rename_wiki_pages if rename
    role = Role.create!(name: "MCP #{name}", permissions: permissions, assignable: false)
    password = "Aa1!#{SecureRandom.hex(24)}"
    user = User.create!(login: "mcp_#{name}", firstname: 'MCP', lastname: name,
                        mail: "#{name}@example.invalid", admin: false,
                        status: User::STATUS_ACTIVE, password: password,
                        password_confirmation: password, mail_notification: 'none')
    Member.create!(project: project, principal: user, roles: [role])
    raise 'Unexpected administrator' if user.admin?
    [:view_wiki_pages, :edit_wiki_pages].each do |permission|
      raise 'Missing Wiki permission' unless user.allowed_to?(permission, project)
    end
    raise 'Unexpected rename permission' unless user.allowed_to?(:rename_wiki_pages, project) == rename
    credentials[name] = user.api_key
    users << { fixture: name, id: user.id, login: user.login, admin: user.admin?,
               role: role.name, permissions: role.permissions.map(&:to_s).sort,
               rename_wiki_pages: user.allowed_to?(:rename_wiki_pages, project) }
  end

  # #3 fixture only: exercise the normal rename callback to prepare a redirect.
  # The feature under test still assigns parents through MCP, never via Ruby.
  author = User.find(users.find { |user| user[:fixture] == 'with_rename' }[:id])
  target = WikiPage.new(wiki: project.wiki, title: 'Previous Parent Name')
  content = WikiContent.new(page: target, text: 'Redirect parent fixture for #3', author: author)
  raise 'Could not create redirect target' unless target.save_with_content(content)
  previous_title = target.title
  target.redirect_existing_links = true
  target.title = 'Redirect Parent Target'
  target.save!
  raise 'Missing redirect fixture' unless project.wiki.find_page(previous_title)&.id == target.id
  parent_fixture = { previous_title: previous_title, target_title: target.title }
end

manifest = {
  redmine_commit: File.read('/opt/redmine-source-commit').strip,
  redmine_version: Redmine::VERSION.to_s, rails_version: Rails.version,
  ruby_version: RUBY_VERSION, bundler_version: Bundler::VERSION,
  database_version: ActiveRecord::Base.connection.select_value('SHOW server_version'),
  gemfile_lock_sha256: Digest::SHA256.file(Rails.root.join('Gemfile.lock')).hexdigest,
  rest_api_enabled: Setting.rest_api_enabled?,
  project: { id: project.id, identifier: project.identifier, modules: project.enabled_module_names },
  users: users, parent_fixture: parent_fixture
}
raise 'REST API or Wiki is disabled' unless manifest[:rest_api_enabled] && project.module_enabled?(:wiki)
# Only the test harness reads this file. Never print it or copy it to evidence.
File.write('/tmp/mcp-integration-credentials.json', JSON.generate(credentials), mode: 'w', perm: 0o600)
File.write('/tmp/mcp-integration-manifest.json', JSON.pretty_generate(manifest) + "\n", mode: 'w', perm: 0o600)
puts 'Disposable project and two non-admin users initialized.'
