module.exports = (sequelize, DataTypes) => {
  const AuditLog = sequelize.define(
    'AuditLog',
    {
      id: {
        type: DataTypes.BIGINT,
        autoIncrement: true,
        primaryKey: true,
      },
      org_id: {
        type: DataTypes.UUID,
        allowNull: true,
      },
      actor_id: {
        type: DataTypes.UUID,
        allowNull: true,
      },
      actor_role: {
        type: DataTypes.STRING,
        allowNull: true,
      },
      action: {
        type: DataTypes.STRING,
        allowNull: false,
      },
      entity_type: DataTypes.STRING,
      entity_id: DataTypes.STRING,
      old_value: DataTypes.JSONB,
      new_value: DataTypes.JSONB,
      ip_address: DataTypes.STRING,
      user_agent: DataTypes.STRING,
      impersonated_by: {
        type: DataTypes.UUID,
        allowNull: true,
      },
      created_at: {
        type: DataTypes.DATE,
        defaultValue: DataTypes.NOW,
      },
    },
    {
      tableName: 'audit_logs',
      timestamps: false,
      underscored: true,
    }
  );

  return AuditLog;
};
